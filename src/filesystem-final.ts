/**
 * Route-aware SSH filesystem provider for the filesystem capability seam.
 * The aggregate `ctx.ssh` connection is the default transport; a cwd of the
 * form `ssh://<connectionId>/<path>` (or a target resolved from such a cwd)
 * routes every operation to that registry-owned connection.
 * @module @deepseek-ai/dsh-fs-ssh
 */

import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { posix } from 'node:path'
import type { Readable } from 'node:stream'
import type { SFTPWrapper, Stats } from 'ssh2'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { quoteShellArg } from './runtime.ts'
import { parseSshTargetKey, resolveSshCwd, resolveSshTargetKey, sshTargetKey } from './transport.ts'
import type { SshTransport } from './transport.ts'

const BINARY_SAMPLE_BYTES = 8192
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

function restoreLineEndings(value: string, crlf: boolean): string {
  return crlf ? normalizeLineEndings(value).replaceAll('\n', '\r\n') : value
}

function decodeText(bytes: Uint8Array, displayPath: string): string {
  if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

function decodeCanonicalPath(encoded: string): string {
  if (encoded.length === 0 || !BASE64.test(encoded)) {
    throw new Error('fs-ssh: canonical path transport returned invalid base64')
  }
  const framed = Buffer.from(encoded, 'base64')
  if (framed.toString('base64') !== encoded || framed.length < 2 || framed.at(-1) !== 0 || framed.subarray(0, -1).includes(0)) {
    throw new Error('fs-ssh: canonical path transport returned invalid NUL framing')
  }
  let path: string
  try {
    path = new TextDecoder('utf-8', { fatal: true }).decode(framed.subarray(0, -1))
  } catch (error: unknown) {
    throw new Error('fs-ssh: canonical path is not valid UTF-8', { cause: error })
  }
  if (!posix.isAbsolute(path)) throw new Error('fs-ssh: canonical path is not absolute')
  return path
}

function entryType(stats: Stats): FsInfo['type'] {
  if (stats.isFile()) return 'file'
  if (stats.isDirectory()) return 'directory'
  return 'other'
}

function entryVersion(stats: Stats, path: string): ReturnType<typeof FsVersion> {
  return FsVersion(`ssh:${createHash('sha256').update(JSON.stringify([path, stats.size, stats.mtime, stats.mode])).digest('hex')}`)
}

function mapError(error: unknown, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true) return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  const code = String((error as { code?: unknown }).code ?? '')
  const message = String(error)
  if (/NO_SUCH_FILE|ENOENT|no such file|does not exist/i.test(`${code} ${message}`)) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (/PERMISSION_DENIED|EACCES|permission denied/i.test(`${code} ${message}`)) {
    return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${message}`, 'FS_IO_ERROR', { cause: error })
}

function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  let matches = 0
  let offset = 0
  while (true) {
    const found = content.indexOf(oldString, offset)
    if (found < 0) break
    matches += 1
    offset = found + oldString.length
  }
  if (matches === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && matches !== 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${matches} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

/** Route-aware remote filesystem backend. */
export class SshFileSystem extends FileSystem {
  static inject = ['ssh']

  private readonly locks = new Map<string, Promise<unknown>>()

  private routeCwd(cwd: string | undefined): { transport: SshTransport; base: string; connectionId?: string } {
    const route = resolveSshCwd(this.ctx, cwd)
    return { transport: route.transport, base: route.cwd, ...(route.connectionId !== undefined ? { connectionId: route.connectionId } : {}) }
  }

  private routeTarget(target: FsTarget): { transport: SshTransport; path: string; connectionId?: string } {
    return resolveSshTargetKey(this.ctx, String(target.targetKey))
  }

  private pathOf(target: FsTarget): string {
    return this.routeTarget(target).path
  }

  private transportOf(target: FsTarget): SshTransport {
    return this.routeTarget(target).transport
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const route = this.routeCwd(opts?.cwd)
    const remotePath = posix.resolve(route.base, path)
    const displayPath = route.connectionId === undefined ? remotePath : sshTargetKey(route.connectionId, remotePath)
    try {
      const canonical = await this.canonicalPath(remotePath, opts?.signal, route.transport)
      assertNotAborted(opts?.signal, 'resolve')
      const targetKey = route.connectionId === undefined ? canonical : sshTargetKey(route.connectionId, canonical)
      return { targetKey: FsTargetKey(targetKey), displayPath }
    } catch (error: unknown) {
      throw mapError(error, 'resolve', displayPath, opts?.signal)
    }
  }

  override processPath(target: FsTarget): string {
    return this.pathOf(target)
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target)
    if (!posix.isAbsolute(path)) throw new Error(`fs-ssh: expected an absolute process path: ${JSON.stringify(path)}`)
    return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const parentRoute = parseSshTargetKey(String(parent.targetKey))
    const childRoute = parseSshTargetKey(String(child.targetKey))
    if (parentRoute.connectionId !== childRoute.connectionId) return false
    const relative = posix.relative(parentRoute.path, childRoute.path)
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    const route = this.routeTarget(target)
    const stats = await this.probe(route.path, target.displayPath, signal, route.transport)
    if (stats === undefined) return undefined
    return {
      version: entryVersion(stats, route.path),
      type: entryType(stats),
      ...(stats.isFile() ? { size: stats.size } : {}),
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const route = this.routeCwd(opts?.cwd)
    const displayPath = posix.resolve(route.base, path)
    const sftp = await route.transport.getSftp()
    try {
      const stats = await new Promise<Stats>((resolve, reject) => {
        sftp.lstat(displayPath, (error, value) => { if (error !== undefined) reject(error); else resolve(value) })
      })
      assertNotAborted(signal, 'lstat')
      const type = stats.isSymbolicLink() ? 'symlink' as const : stats.isFile() ? 'file' as const : stats.isDirectory() ? 'directory' as const : 'other' as const
      return {
        version: entryVersion(stats, displayPath),
        type,
        ...(stats.isFile() ? { size: stats.size } : {}),
      }
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw mapError(error, 'lstat', displayPath, signal)
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    await this.requireRegular(target, signal)
    const bytes = await this.readBytesRaw(target, signal, Number.POSITIVE_INFINITY)
    assertNotAborted(signal, 'read')
    return decodeText(bytes, target.displayPath)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const info = await this.requireRegular(target, signal)
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    const bytes = await this.readBytesRaw(target, signal, maxBytes)
    assertNotAborted(signal, 'read')
    return bytes
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    await this.requireRegular(target, signal)
    const route = this.routeTarget(target)
    const sftp = await route.transport.getSftp()
    const displayPath = target.displayPath
    const stream = sftp.createReadStream(route.path) as Readable
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let sampledBytes = 0
        try {
          for await (const chunk of stream) {
            assertNotAborted(signal, 'read')
            const bytes = Buffer.from(chunk as Uint8Array)
            if (sampledBytes < BINARY_SAMPLE_BYTES) {
              const sample = bytes.subarray(0, BINARY_SAMPLE_BYTES - sampledBytes)
              if (sample.includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
              sampledBytes += sample.length
            }
            try {
              const text = decoder.decode(bytes, { stream: true })
              if (text.length > 0) yield text
            } catch (error: unknown) {
              throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
            }
          }
          try {
            decoder.decode()
          } catch (error: unknown) {
            throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
          }
        } catch (error: unknown) {
          throw mapError(error, 'read', displayPath, signal)
        }
      },
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    const route = this.routeTarget(target)
    const sftp = await route.transport.getSftp()
    try {
      const listed = await new Promise<Array<{ filename: string; attrs: Stats }>>((resolve, reject) => {
        sftp.readdir(route.path, (error, value) => { if (error !== undefined) reject(error); else resolve(value) })
      })
      assertNotAborted(signal, 'list')
      const targetRoute = parseSshTargetKey(String(target.targetKey))
      const entries: FsDirEntry[] = []
      for (const entry of listed) {
        const childRemotePath = posix.join(route.path, entry.filename)
        const canonical = await this.canonicalPath(childRemotePath, signal, route.transport)
        const childKey = targetRoute.connectionId === undefined ? canonical : sshTargetKey(targetRoute.connectionId, canonical)
        const childDisplayPath = targetRoute.connectionId === undefined ? childRemotePath : sshTargetKey(targetRoute.connectionId, childRemotePath)
        entries.push({
          name: entry.filename,
          type: entryType(entry.attrs),
          target: { targetKey: FsTargetKey(childKey), displayPath: childDisplayPath },
          version: entryVersion(entry.attrs, canonical),
          ...(entry.attrs.isFile() ? { size: entry.attrs.size } : {}),
        })
      }
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    } catch (error: unknown) {
      throw mapError(error, 'list', target.displayPath, signal)
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const route = this.routeTarget(target)
      const existing = await this.probe(route.path, target.displayPath, signal, route.transport)
      if (existing !== undefined && !existing.isFile()) {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target)
      const before = existing === undefined ? null : await this.readForDiff(target, signal)
      const version = await this.writeAtomic(target, content, existing, expected?.kind === 'createIfAbsent', signal)
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const route = this.routeTarget(target)
      const existing = await this.probe(route.path, target.displayPath, signal, route.transport)
      if (existing === undefined) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (!existing.isFile()) {
        throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && entryVersion(existing, route.path) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readForEdit(target, signal)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const storage = restoreLineEndings(after, detectsCrlf(raw))
      const version = await this.writeAtomic(target, storage, existing, false, signal)
      return { version, before, after }
    })
  }

  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(targetKey) ?? Promise.resolve()
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    this.locks.set(targetKey, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(targetKey) === tail) this.locks.delete(targetKey)
    }
  }

  private async canonicalPath(path: string, signal?: AbortSignal, transport: SshTransport = this.ctx.ssh as unknown as SshTransport): Promise<string> {
    const result = await transport.exec(
      `set -o pipefail; realpath -mz -- ${quoteShellArg(path)} | base64 -w0`,
      signal !== undefined ? { signal } : undefined,
    )
    signal?.throwIfAborted()
    if (result.exitCode !== 0) throw new Error(result.stderr || `realpath failed for ${path}`)
    return decodeCanonicalPath(result.stdout.trim())
  }

  private async probe(path: string, displayPath: string, signal?: AbortSignal, transport: SshTransport = this.ctx.ssh as unknown as SshTransport): Promise<Stats | undefined> {
    assertNotAborted(signal, 'stat')
    const sftp = await transport.getSftp()
    try {
      const stats = await new Promise<Stats>((resolve, reject) => {
        sftp.stat(path, (error, value) => { if (error !== undefined) reject(error); else resolve(value) })
      })
      assertNotAborted(signal, 'stat')
      return stats
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw mapError(error, 'stat', displayPath, signal)
    }
  }

  private async requireRegular(target: FsTarget, signal?: AbortSignal): Promise<FsInfo> {
    const info = await this.stat(target, signal)
    if (info === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    return info
  }

  private async readBytesRaw(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const route = this.routeTarget(target)
    const sftp = await route.transport.getSftp()
    try {
      const data = await new Promise<Buffer>((resolve, reject) => {
        sftp.readFile(route.path, (error, value) => { if (error !== undefined) reject(error); else resolve(value) })
      })
      assertNotAborted(signal, 'read')
      if (data.length > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
      }
      return data
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  private checkWriteIntent(existing: Stats | undefined, expected: FsWriteIntent | undefined, target: FsTarget): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || entryVersion(existing, this.pathOf(target)) !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    }
  }

  private async readForDiff(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      return normalizeLineEndings(decodeText(await this.readBytesRaw(target, signal, Number.POSITIVE_INFINITY), target.displayPath))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  private async readForEdit(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return decodeText(await this.readBytesRaw(target, signal, Number.POSITIVE_INFINITY), target.displayPath)
  }

  private async writeAtomic(
    target: FsTarget,
    content: string,
    existing: Stats | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof FsVersion>> {
    assertNotAborted(signal, 'write')
    const route = this.routeTarget(target)
    const targetPath = route.path
    const stagingDirectory = posix.join(posix.dirname(targetPath), `.dsh-${randomUUID()}.tmp`)
    const temporary = posix.join(stagingDirectory, 'content')
    let stagingCreated = false
    try {
      const sftp = await route.transport.getSftp()
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(stagingDirectory, error => { if (error !== undefined) reject(error); else resolve() })
      })
      stagingCreated = true
      await new Promise<void>((resolve, reject) => {
        sftp.writeFile(temporary, content, error => { if (error !== undefined) reject(error); else resolve() })
      })
      assertNotAborted(signal, 'write')
      const mode = existing === undefined ? 0o600 : existing.mode & 0o777
      await route.transport.exec(`chmod ${mode.toString(8)} -- ${quoteShellArg(temporary)}`, signal !== undefined ? { signal } : undefined)
      assertNotAborted(signal, 'write')
      if (createIfAbsent) {
        const publication = await route.transport.exec(
          `if ln -T -- ${quoteShellArg(temporary)} ${quoteShellArg(targetPath)}; then printf created; elif test -e ${quoteShellArg(targetPath)} || test -L ${quoteShellArg(targetPath)}; then printf exists; else exit 1; fi`,
          signal !== undefined ? { signal } : undefined,
        )
        if (publication.stdout === 'exists') {
          throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
        }
        if (publication.stdout !== 'created') throw new Error('guarded create returned an invalid publication result')
      } else {
        await new Promise<void>((resolve, reject) => {
          sftp.rename(temporary, targetPath, error => { if (error !== undefined) reject(error); else resolve() })
        })
      }
      assertNotAborted(signal, 'write')
      await this.removeStaging(stagingDirectory, route.transport)
      const committed = await this.probe(targetPath, target.displayPath, signal, route.transport)
      if (committed === undefined) throw new FsError(`cannot write "${target.displayPath}": commit produced no file`, 'FS_IO_ERROR')
      return entryVersion(committed, targetPath)
    } catch (error: unknown) {
      if (stagingCreated) await this.removeStaging(stagingDirectory, route.transport)
      throw mapError(error, 'write', target.displayPath, signal)
    }
  }

  private async removeStaging(directory: string, transport: SshTransport = this.ctx.ssh as unknown as SshTransport): Promise<void> {
    const sftp = await transport.getSftp()
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.rmdir(directory, error => { if (error !== undefined) reject(error); else resolve() })
      })
    } catch {
      // The target is already committed; an empty private directory cannot turn that write into a failure.
    }
  }
}

/** Whether one SFTP/exec error means "path absent". */
function isNotFound(error: unknown): boolean {
  const code = String((error as { code?: unknown }).code ?? '')
  const message = String(error)
  return /NO_SUCH_FILE|ENOENT|no such file|does not exist/i.test(`${code} ${message}`)
}

export default SshFileSystem
