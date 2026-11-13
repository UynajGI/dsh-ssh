/**
 * Local filesystem delegate for hybrid hosts: a Windows workspace opened
 * before this plugin was mounted keeps its drive-letter paths, which no POSIX
 * remote can serve. Those paths are served by `node:fs` here while every
 * remote route keeps the SSH backend, so one `ctx.fs` slot can cover both.
 * @module dsh-ssh/filesystem-local
 */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fsp } from 'node:fs'
import type { Stats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Buffer } from 'node:buffer'
import { applyHunks } from '@deepseek-ai/dsh-fs-patch'
import type { PatchHunk } from '@deepseek-ai/dsh-fs-patch'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
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

const BINARY_SAMPLE_BYTES = 8192
const BASIS_MAX_BYTES = 256 * 1024

/** Whether one path is absolute in the local Windows namespace. */
export function isLocalAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value)
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

function mapError(error: unknown, operation: string, displayPath: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true) return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  const code = String((error as { code?: unknown }).code ?? '')
  const message = error instanceof Error ? error.message : String(error)
  if (/ENOENT|no such file/i.test(`${code} ${message}`)) {
    return new FsError(`cannot ${operation} "${displayPath}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (/EACCES|EPERM|permission denied/i.test(`${code} ${message}`)) {
    return new FsError(`cannot ${operation} "${displayPath}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  if (/EEXIST|file already exists/i.test(`${code} ${message}`)) {
    return new FsError(`cannot ${operation} "${displayPath}": already exists`, 'FS_ALREADY_EXISTS', { cause: error })
  }
  return new FsError(`cannot ${operation} "${displayPath}": ${message}`, 'FS_IO_ERROR', { cause: error })
}

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function localVersion(path: string, stats: Stats): ReturnType<typeof FsVersion> {
  return FsVersion(`local:${createHash('sha256').update(JSON.stringify([path, stats.size, stats.mtimeMs, stats.mode])).digest('hex')}`)
}

function entryType(stats: Stats): FsInfo['type'] {
  if (stats.isFile()) return 'file'
  if (stats.isDirectory()) return 'directory'
  return 'other'
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

/** Local half of the hybrid filesystem; targets carry native absolute paths. */
export class LocalFileSystem {
  private readonly locks = new Map<string, Promise<unknown>>()

  /** Resolve a local path to its canonical target. */
  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const base = opts?.cwd !== undefined && isAbsolute(opts.cwd) ? opts.cwd : process.cwd()
    const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path)
    let canonical = absolute
    try {
      canonical = await fsp.realpath(absolute)
    } catch (error: unknown) {
      const code = String((error as { code?: unknown }).code ?? '')
      if (!/ENOENT/i.test(code)) throw mapError(error, 'resolve', absolute, opts?.signal)
    }
    return { targetKey: FsTargetKey(canonical), displayPath: canonical }
  }

  processPath(target: FsTarget): string {
    return String(target.targetKey)
  }

  fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const rel = relative(this.processPath(parent), this.processPath(child))
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    assertNotAborted(signal, 'stat')
    const path = this.processPath(target)
    try {
      const stats = await fsp.stat(path)
      return {
        version: localVersion(path, stats),
        type: entryType(stats),
        ...(stats.isFile() ? { size: stats.size } : {}),
      }
    } catch (error: unknown) {
      if (/ENOENT|ENOTDIR/i.test(String((error as { code?: unknown }).code ?? ''))) return undefined
      throw mapError(error, 'stat', target.displayPath, signal)
    }
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    assertNotAborted(signal, 'lstat')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const base = opts?.cwd !== undefined && isAbsolute(opts.cwd) ? opts.cwd : process.cwd()
    const absolute = isAbsolute(path) ? resolve(path) : resolve(base, path)
    try {
      const stats = await fsp.lstat(absolute)
      const type = stats.isSymbolicLink() ? 'symlink' as const : stats.isFile() ? 'file' as const : stats.isDirectory() ? 'directory' as const : 'other' as const
      return {
        version: localVersion(absolute, stats),
        type,
        ...(stats.isFile() ? { size: stats.size } : {}),
      }
    } catch (error: unknown) {
      if (/ENOENT|ENOTDIR/i.test(String((error as { code?: unknown }).code ?? ''))) return undefined
      throw mapError(error, 'lstat', absolute, signal)
    }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    assertNotAborted(signal, 'read')
    return decodeText(await fsp.readFile(this.processPath(target)), target.displayPath)
  }

  async readBytes(target: FsTarget, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const bytes = await fsp.readFile(this.processPath(target))
    if (bytes.length > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    return bytes
  }

  async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    assertNotAborted(signal, 'read')
    const handle = await fsp.open(this.processPath(target), 'r')
    try {
      const buffer = Buffer.alloc(range.length)
      const { bytesRead } = await handle.read(buffer, 0, range.length, range.offset)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const displayPath = target.displayPath
    const stream = createReadStream(this.processPath(target))
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

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    assertNotAborted(signal, 'list')
    const path = this.processPath(target)
    let entries
    try {
      entries = await fsp.readdir(path, { withFileTypes: true })
    } catch (error: unknown) {
      throw mapError(error, 'list', target.displayPath, signal)
    }
    const rows: FsDirEntry[] = []
    for (const entry of entries) {
      const child = join(path, entry.name)
      const type = entry.isFile() ? 'file' as const : entry.isDirectory() ? 'directory' as const : 'other' as const
      rows.push({
        name: entry.name,
        type,
        target: { targetKey: FsTargetKey(child), displayPath: child },
      })
    }
    return rows.sort((left, right) => left.name.localeCompare(right.name))
  }

  async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      assertNotAborted(signal, 'write')
      const path = this.processPath(target)
      const existing = await this.probe(path, target.displayPath, signal)
      if (existing !== undefined && !existing.isFile()) {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(existing, expected, target, path)
      const before = existing === undefined ? null : await this.readBasis(target, signal)
      const version = await this.writeAtomic(path, target.displayPath, content, existing, expected?.kind === 'createIfAbsent', signal)
      return {
        operation: existing === undefined ? 'create' : 'update',
        version,
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const path = this.processPath(target)
      const existing = await this.probe(path, target.displayPath, signal)
      if (existing === undefined || !existing.isFile()) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (expected !== undefined && localVersion(path, existing) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await fsp.readFile(path, 'utf8')
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      const version = await this.writeAtomic(path, target.displayPath, restoreLineEndings(after, detectsCrlf(raw)), existing, false, signal)
      return { version, before, after }
    })
  }

  async patchText(
    target: FsTarget,
    hunks: readonly PatchHunk[],
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const path = this.processPath(target)
      const existing = await this.probe(path, target.displayPath, signal)
      if (existing === undefined || !existing.isFile()) {
        throw new FsError(`cannot patch "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (expected !== undefined && localVersion(path, existing) !== expected.version) {
        throw new FsError(`cannot patch "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await fsp.readFile(path, 'utf8')
      const before = normalizeLineEndings(raw)
      const applied = applyHunks(before, hunks)
      if (!applied.ok) {
        throw new FsError(
          `cannot patch "${target.displayPath}": hunk at line ${applied.failure.hunkLineNumber} did not match`,
          'FS_PATCH_MISMATCH',
        )
      }
      const version = await this.writeAtomic(path, target.displayPath, restoreLineEndings(applied.after, detectsCrlf(raw)), existing, false, signal)
      return { version, before, after: applied.after }
    })
  }

  async deleteFile(target: FsTarget, expected?: { version: ReturnType<typeof FsVersion> }, signal?: AbortSignal): Promise<FsDeleteOutcome> {
    return this.withLock(String(target.targetKey), async () => {
      const path = this.processPath(target)
      const existing = await this.probe(path, target.displayPath, signal)
      if (existing === undefined) {
        throw new FsError(`cannot delete "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (!existing.isFile()) {
        throw new FsError(`cannot delete "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected !== undefined && localVersion(path, existing) !== expected.version) {
        throw new FsError(`cannot delete "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const before = await this.readBasis(target, signal)
      try {
        await fsp.unlink(path)
      } catch (error: unknown) {
        throw mapError(error, 'delete', target.displayPath, signal)
      }
      return { before }
    })
  }

  async moveFile(
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
    return this.withLock(sourceKey, () => this.withLock(destinationKey, async () => {
      const sourcePath = this.processPath(source)
      const existing = await this.probe(sourcePath, source.displayPath, signal)
      if (existing === undefined || !existing.isFile()) {
        throw new FsError(`cannot move "${source.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      if (options.expectedSource !== undefined && localVersion(sourcePath, existing) !== options.expectedSource.version) {
        throw new FsError(`cannot move "${source.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
      const raw = await fsp.readFile(sourcePath, 'utf8')
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
      const destinationPath = this.processPath(destination)
      const destinationExisting = await this.probe(destinationPath, destination.displayPath, signal)
      if (destinationExisting !== undefined && !destinationExisting.isFile()) {
        throw new FsError(`cannot write "${destination.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      this.checkWriteIntent(destinationExisting, options.expectedDestination, destination, destinationPath)
      const destinationBefore = destinationExisting === undefined ? null : await this.readBasis(destination, signal)
      const version = await this.writeAtomic(
        destinationPath,
        destination.displayPath,
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
        await fsp.unlink(sourcePath)
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
    }))
  }

  private async probe(path: string, displayPath: string, signal?: AbortSignal): Promise<Stats | undefined> {
    assertNotAborted(signal, 'stat')
    try {
      return await fsp.stat(path)
    } catch (error: unknown) {
      if (/ENOENT|ENOTDIR/i.test(String((error as { code?: unknown }).code ?? ''))) return undefined
      throw mapError(error, 'stat', displayPath, signal)
    }
  }

  private async readBasis(target: FsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      const bytes = await fsp.readFile(this.processPath(target))
      if (bytes.length > BASIS_MAX_BYTES) return null
      return normalizeLineEndings(decodeText(bytes, target.displayPath))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  private checkWriteIntent(existing: Stats | undefined, expected: FsWriteIntent | undefined, target: FsTarget, path: string): void {
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion') {
      if (existing === undefined || localVersion(path, existing) !== expected.version) {
        throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
      }
    }
  }

  private async writeAtomic(
    path: string,
    displayPath: string,
    content: string,
    existing: Stats | undefined,
    createIfAbsent: boolean,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof FsVersion>> {
    assertNotAborted(signal, 'write')
    const directory = dirname(path)
    const temporary = join(directory, `.dsh-${randomUUID()}.tmp`)
    try {
      await fsp.writeFile(temporary, content, { mode: existing === undefined ? 0o600 : existing.mode & 0o777 })
      assertNotAborted(signal, 'write')
      if (createIfAbsent) {
        try {
          await fsp.link(temporary, path)
        } catch (error: unknown) {
          if (/EEXIST/i.test(String((error as { code?: unknown }).code ?? ''))) {
            throw new FsError(`cannot overwrite existing "${displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
          }
          throw error
        }
        await fsp.unlink(temporary).catch(() => undefined)
      } else {
        await fsp.rename(temporary, path)
      }
      assertNotAborted(signal, 'write')
      const committed = await this.probe(path, displayPath, signal)
      if (committed === undefined) throw new FsError(`cannot write "${displayPath}": commit produced no file`, 'FS_IO_ERROR')
      return localVersion(path, committed)
    } catch (error: unknown) {
      await fsp.unlink(temporary).catch(() => undefined)
      throw mapError(error, 'write', displayPath, signal)
    }
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
}
