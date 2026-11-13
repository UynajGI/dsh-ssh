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
import { applyHunks } from '@deepseek-ai/dsh-fs-patch'
import type { PatchHunk } from '@deepseek-ai/dsh-fs-patch'
import type {
  FsDeleteOutcome,
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsMoveOutcome,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { quoteShellArg } from './runtime.ts'
import { LocalFileSystem, isLocalAbsolutePath } from './filesystem-local.ts'
import { isSshRoutePlaceholder, resolveSshPath, resolveSshTargetKey, sshTargetKey } from './transport.ts'
import type { SshTransport } from './transport.ts'

const BINARY_SAMPLE_BYTES = 8192
/** Cap on the LF-normalized basis returned for diffs and removes. */
const BASIS_MAX_BYTES = 256 * 1024
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
  /** Local half of the hybrid: Windows drive/UNC workspaces stay on this host. */
  private readonly local = new LocalFileSystem()

  /**
   * Whether one caller path belongs to the local host rather than a remote.
   * A drive-letter/UNC path is local unless it sits in the registry placeholder
   * tree (which is drive-letter-shaped on Windows); a relative path under a
   * local cwd is local too. POSIX absolute paths and `ssh://` routes stay
   * remote.
   */
  private isLocalPath(path: string, cwd: string | undefined): boolean {
    if (path.startsWith('ssh://')) return false
    if (isLocalAbsolutePath(path)) return !isSshRoutePlaceholder(path)
    if (cwd === undefined || !isLocalAbsolutePath(cwd) || isSshRoutePlaceholder(cwd)) return false
    return !posix.isAbsolute(path)
  }

  private targetIsLocal(target: FsTarget): boolean {
    const key = String(target.targetKey)
    return isLocalAbsolutePath(key) && !isSshRoutePlaceholder(key)
  }

  private routePath(path: string, cwd: string | undefined): { transport: SshTransport; remotePath: string; connectionId?: string; displayPath: string } {
    const route = resolveSshPath(this.ctx, path, cwd)
    return {
      transport: route.transport,
      remotePath: route.path,
      ...(route.connectionId !== undefined ? { connectionId: route.connectionId } : {}),
      displayPath: route.connectionId === undefined ? route.path : sshTargetKey(route.connectionId, route.path),
    }
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
    if (this.isLocalPath(path, opts?.cwd)) return this.local.resolve(path, opts)
    const route = this.routePath(path, opts?.cwd)
    const remotePath = route.remotePath
    const displayPath = route.displayPath
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
    if (this.targetIsLocal(target)) return this.local.processPath(target)
    return this.pathOf(target)
  }

  override fileUrl(target: FsTarget): string {
    if (this.targetIsLocal(target)) return this.local.fileUrl(target)
    const path = this.processPath(target)
    if (!posix.isAbsolute(path)) throw new Error(`fs-ssh: expected an absolute process path: ${JSON.stringify(path)}`)
    return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    if (this.targetIsLocal(parent) || this.targetIsLocal(child)) {
      return this.targetIsLocal(parent) && this.targetIsLocal(child) && this.local.contains(parent, child)
    }
    const parentRoute = this.routeTarget(parent)
    const childRoute = this.routeTarget(child)
    if (parentRoute.connectionId !== childRoute.connectionId) return false
    const relative = posix.relative(parentRoute.path, childRoute.path)
    return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    if (this.targetIsLocal(target)) return this.local.stat(target, signal)
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
    if (this.isLocalPath(path, opts?.cwd)) return this.local.lstat(path, opts, signal)
    const route = this.routePath(path, opts?.cwd)
    const displayPath = route.displayPath
    const sftp = await route.transport.getSftp()
    try {
      const stats = await new Promise<Stats>((resolve, reject) => {
        sftp.lstat(route.remotePath, (error, value) => { if (error !== undefined) reject(error); else resolve(value) })
      })
      assertNotAborted(signal, 'lstat')
      const type = stats.isSymbolicLink() ? 'symlink' as const : stats.isFile() ? 'file' as const : stats.isDirectory() ? 'directory' as const : 'other' as const
      return {
        version: entryVersion(stats, route.remotePath),
        type,
        ...(stats.isFile() ? { size: stats.size } : {}),
      }
    } catch (error: unknown) {
      if (isNotFound(error)) return undefined
      throw mapError(error, 'lstat', displayPath, signal)
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    if (this.targetIsLocal(target)) return this.local.readText(target, signal)
    await this.requireRegular(target, signal)
    const bytes = await this.readBytesRaw(target, signal, Number.POSITIVE_INFINITY)
    assertNotAborted(signal, 'read')
    return decodeText(bytes, target.displayPath)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    if (this.targetIsLocal(target)) return this.local.readBytes(target, signal, maxBytes)
    const info = await this.requireRegular(target, signal)
    if (info.size !== undefined && info.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${info.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    const bytes = await this.readBytesRaw(target, signal, maxBytes)
    assertNotAborted(signal, 'read')
    return bytes
  }

  override async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!Number.isInteger(range.offset) || range.offset < 0 || !Number.isInteger(range.length) || range.length < 0) {
      throw new FsError(`cannot read "${target.displayPath}": range offset and length must be non-negative integers`, 'FS_IO_ERROR')
    }
    if (this.targetIsLocal(target)) return this.local.readByteRange(target, range, signal)
    await this.requireRegular(target, signal)
    assertNotAborted(signal, 'read')
    if (range.length === 0) return new Uint8Array(0)
    const route = this.routeTarget(target)
    const sftp = await route.transport.getSftp()
    try {
      const data = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        const stream = sftp.createReadStream(route.path, { start: range.offset, end: range.offset + range.length - 1 })
        stream.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        stream.on('error', reject)
        stream.on('end', () => resolve(Buffer.concat(chunks)))
      })
      assertNotAborted(signal, 'read')
      return data.subarray(0, range.length)
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (this.targetIsLocal(target)) return this.local.streamText(target, signal)
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
    if (this.targetIsLocal(target)) return this.local.listDir(target, signal)
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
      const entries: FsDirEntry[] = []
      for (const entry of listed) {
        const childRemotePath = posix.join(route.path, entry.filename)
        const canonical = await this.canonicalPath(childRemotePath, signal, route.transport)
        const childKey = route.connectionId === undefined ? canonical : sshTargetKey(route.connectionId, canonical)
        const childDisplayPath = route.connectionId === undefined ? childRemotePath : sshTargetKey(route.connectionId, childRemotePath)
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
    if (this.targetIsLocal(target)) return this.local.writeText(target, content, expected, signal)
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
    if (this.targetIsLocal(target)) return this.local.editText(target, edit, expected, signal)
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

  override async patchText(
    target: FsTarget,
    hunks: readonly PatchHunk[],
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    if (this.targetIsLocal(target)) return this.local.patchText(target, hunks, expected, signal)
    return this.withLock(String(target.targetKey), async () => {
      const route = this.routeTarget(target)
      const existing = await this.probe(route.path, target.displayPath, signal, route.transport)
      if (existing === undefined || !existing.isFile()) {
        throw new FsError(`cannot patch "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (expected !== undefined && entryVersion(existing, route.path) !== expected.version) {
        throw new FsError(`cannot patch "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readForEdit(target, signal)
      const before = normalizeLineEndings(raw)
      const applied = applyHunks(before, hunks)
      if (!applied.ok) {
        throw new FsError(
          `cannot patch "${target.displayPath}": hunk at line ${applied.failure.hunkLineNumber} did not match`,
          'FS_PATCH_MISMATCH',
        )
      }
      const storage = restoreLineEndings(applied.after, detectsCrlf(raw))
      const version = await this.writeAtomic(target, storage, existing, false, signal)
      return { version, before, after: applied.after }
    })
  }

  override async deleteFile(
    target: FsTarget,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsDeleteOutcome> {
    if (this.targetIsLocal(target)) return this.local.deleteFile(target, expected, signal)
    return this.withLock(String(target.targetKey), async () => {
      const route = this.routeTarget(target)
      const existing = await this.probe(route.path, target.displayPath, signal, route.transport)
      if (existing === undefined) {
        throw new FsError(`cannot delete "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (!existing.isFile()) {
        throw new FsError(`cannot delete "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && entryVersion(existing, route.path) !== expected.version) {
        throw new FsError(`cannot delete "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const before = await this.readBasis(target, signal)
      const sftp = await route.transport.getSftp()
      await new Promise<void>((resolvePromise, reject) => {
        sftp.unlink(route.path, error => { if (error !== undefined) reject(error); else resolvePromise() })
      })
      return { before }
    })
  }

  override async moveFile(
    source: FsTarget,
    destination: FsTarget,
    options: {
      hunks?: readonly PatchHunk[]
      expectedSource?: { version: ReturnType<typeof FsVersion> }
      expectedDestination?: FsWriteIntent
    },
    signal?: AbortSignal,
  ): Promise<FsMoveOutcome> {
    const sourceKey = String(source.targetKey)
    const destinationKey = String(destination.targetKey)
    if (sourceKey === destinationKey) {
      throw new FsError(`cannot move "${source.displayPath}" onto itself`, 'FS_SAME_TARGET')
    }
    if (this.targetIsLocal(source) && this.targetIsLocal(destination)) {
      return this.local.moveFile(source, destination, options, signal)
    }
    const [first, second] = sourceKey < destinationKey ? [sourceKey, destinationKey] : [destinationKey, sourceKey]
    return this.withLocks([first, second], async () => {
      const sourceRoute = this.routeTarget(source)
      const existing = await this.probe(sourceRoute.path, source.displayPath, signal, sourceRoute.transport)
      if (existing === undefined || !existing.isFile()) {
        throw new FsError(`cannot move "${source.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (options.expectedSource !== undefined && entryVersion(existing, sourceRoute.path) !== options.expectedSource.version) {
        throw new FsError(`cannot move "${source.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await this.readForEdit(source, signal)
      const normalized = normalizeLineEndings(raw)
      let next = normalized
      if (options.hunks !== undefined && options.hunks.length > 0) {
        const applied = applyHunks(normalized, options.hunks)
        if (!applied.ok) {
          throw new FsError(
            `cannot move "${source.displayPath}": hunk at line ${applied.failure.hunkLineNumber} did not match`,
            'FS_PATCH_MISMATCH',
          )
        }
        next = applied.after
      }
      const destinationRoute = this.routeTarget(destination)
      const destinationExisting = await this.probe(destinationRoute.path, destination.displayPath, signal, destinationRoute.transport)
      if (destinationExisting !== undefined && !destinationExisting.isFile()) {
        throw new FsError(`cannot write "${destination.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(destinationExisting, options.expectedDestination, destination)
      const destinationBefore = destinationExisting === undefined ? null : await this.readBasis(destination, signal)
      const version = await this.writeAtomic(
        destination,
        restoreLineEndings(next, detectsCrlf(raw)),
        destinationExisting,
        options.expectedDestination?.kind === 'createIfAbsent',
        signal,
      )
      const destinationOutcome: FsWriteOutcome = {
        operation: destinationExisting === undefined ? 'create' : 'update',
        version,
        before: destinationBefore,
        after: next,
      }
      const sourceBefore = await this.readBasis(source, signal)
      try {
        const sftp = await sourceRoute.transport.getSftp()
        await new Promise<void>((resolvePromise, reject) => {
          sftp.unlink(sourceRoute.path, error => { if (error !== undefined) reject(error); else resolvePromise() })
        })
        return { sourceBefore, destination: destinationOutcome, sourceDeleted: true }
      } catch (error: unknown) {
        const failure = mapError(error, 'delete', source.displayPath, signal)
        return {
          sourceBefore,
          destination: destinationOutcome,
          sourceDeleted: false,
          sourceFailure: { code: failure.code, message: failure.message },
        }
      }
    })
  }

  private async withLock<T>(targetKey: string, operation: () => Promise<T>): Promise<T> {
    return this.withLocks([targetKey], operation)
  }

  private async withLocks<T>(targetKeys: string[], operation: () => Promise<T>): Promise<T> {
    const keys = [...new Set(targetKeys)].sort()
    const prior = Promise.all(keys.map(key => this.locks.get(key) ?? Promise.resolve()))
    const run = prior.then(operation, operation)
    const tail = run.then(() => undefined, () => undefined)
    for (const key of keys) this.locks.set(key, tail)
    try {
      return await run
    } finally {
      for (const key of keys) {
        if (this.locks.get(key) === tail) this.locks.delete(key)
      }
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

  private async readBasis(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      const bytes = await this.readBytesRaw(target, signal, BASIS_MAX_BYTES)
      return normalizeLineEndings(decodeText(bytes, target.displayPath))
    } catch (error: unknown) {
      if (error instanceof FsError && (error.code === 'FS_NOT_TEXT' || error.code === 'FS_TOO_LARGE')) return null
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
