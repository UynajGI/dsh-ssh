/**
 * Directory-picker browse backend over the dsh-ssh connection: the web GUI's
 * "Select Workspace Directory" dialog — the add-workspace flow — browses the
 * remote host through the shared SFTP channel, and picked remote paths become
 * workspace paths the dsh-ssh providers already understand.
 *
 * Behavior facts:
 * - On a Windows host the picker is dual-root: local listings keep the
 *   drive-qualified paths of the host account (so the existing local browsing
 *   is unchanged), the remote host appears as one pinned entry on the local
 *   home level, and every POSIX-absolute path addresses the remote host —
 *   the same routing rule as {@link SshRuntime.resolveRemoteCwd}.
 * - On a POSIX host every absolute path addresses the remote host, so the
 *   picker is remote-only (the local filesystem is unreachable through it;
 *   it would share the remote path vocabulary).
 * - Remote listings return directories only, name-sorted, symlinks to
 *   directories followed, `hidden` means dot-prefixed, and one level is
 *   bounded at `maxEntries` rows with `truncated` flagging a cut.
 * - `createDirectory` is non-recursive SFTP mkdir with an existence probe.
 *
 * Mount as its own row (`dsh-ssh/picker`): the directory-picker seam registers
 * one implementation per context, so this row must REPLACE the deployment's
 * existing `directory-picker` row (the web bundle's
 * `@deepseek-ai/dsh-host-directory-picker-auto`), not sit beside it, and the
 * shipped in-app browser surface
 * (`@deepseek-ai/dsh-client-ui-directory-picker-browse`) must be composed
 * separately because replacing `-auto` drops the surface it mounted.
 * @module dsh-ssh/picker
 */

import { mkdir, opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix, resolve, win32 } from 'node:path'
import type { SFTPWrapper, Stats } from 'ssh2'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DirectoryPicker, DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type {
  DirectoryEntry,
  DirectoryListing,
  DirectoryPickerBrowseCapability,
  DirectoryPickerCapability,
} from '@deepseek-ai/dsh-host-directory-picker'
import type { SshRuntime } from './runtime.ts'

/** Configuration for the directory-picker browse backend. */
export interface Config {
  /**
   * Complete-result bound for one remote or local level: at most this many
   * child-directory rows (hidden rows count toward the bound), with
   * `truncated` flagging a cut level. Defaults to 1000, the bound GitHub's
   * web UI applies to directory listings.
   */
  maxEntries?: number
  /**
   * Name of the pinned remote-host entry shown on the local home level
   * (Windows hosts only). Defaults to `Remote host <username>@<host>`.
   */
  remoteLabel?: string
  /**
   * Name of the pinned local-host entry shown on the remote home level
   * (Windows hosts only). Defaults to `Local host`.
   */
  localLabel?: string
}

/** Resolved config with every default filled by Schemastery before construction. */
interface ResolvedConfig {
  maxEntries: number
  remoteLabel?: string
  localLabel?: string
}

/** The thrown value as an Error (wire/abort reasons may be anything). */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Await `operation`, but reject with the signal's reason the moment it
 * aborts. SFTP reads are not retractable, so the operation itself keeps
 * running against a channel the caller then abandons — its late settlement
 * is swallowed here so an abandoned read cannot surface as an unhandled
 * rejection.
 * @param operation - the in-flight step.
 * @param signal - caller lifetime; absent means plain awaiting.
 * @returns the operation's value.
 */
function raceAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = (): void => {
      operation.catch(() => {})
      reject(asError(signal.reason))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolvePromise(value)
      },
      (reason: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(reason))
      },
    )
  })
}

/**
 * Insert a streamed candidate into the name-ascending bounded window,
 * evicting the name-largest candidate when the window exceeds `keep`.
 * Memory over an arbitrarily large level stays O(keep).
 * @param window - the name-ascending window, mutated in place.
 * @param candidate - the streamed candidate to place.
 * @param keep - the window bound.
 * @returns true when an eviction happened (the level has candidates beyond the window).
 */
function boundedInsert<T extends { name: string }>(window: T[], candidate: T, keep: number): boolean {
  const tail = window[window.length - 1]
  if (window.length === keep && tail !== undefined && candidate.name.localeCompare(tail.name) >= 0) return true
  let lo = 0
  let hi = window.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const middle = window[mid]
    if (middle !== undefined && candidate.name.localeCompare(middle.name) < 0) hi = mid
    else lo = mid + 1
  }
  window.splice(lo, 0, candidate)
  if (window.length <= keep) return false
  window.pop()
  return true
}

/**
 * True when the path names one fixed Windows filesystem location regardless
 * of process state: drive-qualified (`C:\…`, `C:/…`) or complete UNC
 * (`\\server\share…`, `//server/share…`). Rooted drive-less forms (`\foo`,
 * `/foo`) and incomplete UNC prefixes pass `isAbsolute` yet still resolve
 * against the process's current drive, so they do not count.
 * @param path - candidate path.
 */
function fullyQualifiedWin32(path: string): boolean {
  return win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/])/.test(path)
}

/**
 * Ancestor chain from the filesystem root to `target` inclusive — the
 * breadcrumb rows of a listing, every one a jump target.
 */
function ancestryCrumbs(target: string, dirnameOf: (path: string) => string, basenameOf: (path: string) => string): DirectoryEntry[] {
  const crumbs: DirectoryEntry[] = []
  let current = target
  for (;;) {
    const parent = dirnameOf(current)
    crumbs.unshift({
      name: parent === current ? current : basenameOf(current),
      path: current,
      hidden: false,
    })
    if (parent === current) return crumbs
    current = parent
  }
}

/** Resolve one SFTP stat, following symlinks. */
function sftpStat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise<Stats>((resolvePromise, reject) => {
    sftp.stat(path, (error, value) => { if (error !== undefined) reject(error); else resolvePromise(value) })
  })
}

/** Read one remote directory level with name-sorted entries and attr facts. */
function sftpReadDir(sftp: SFTPWrapper, path: string): Promise<Array<{ filename: string; attrs: Stats }>> {
  return new Promise<Array<{ filename: string; attrs: Stats }>>((resolvePromise, reject) => {
    sftp.readdir(path, (error, value) => { if (error !== undefined) reject(error); else resolvePromise(value) })
  })
}

/** One probed row of a remote level: a directory, a symlink to one, or nothing. */
async function remoteDirectoryRow(
  sftp: SFTPWrapper,
  parent: string,
  name: string,
  isDirectory: boolean,
  isSymbolicLink: boolean,
  signal?: AbortSignal,
): Promise<DirectoryEntry | null> {
  const path = posix.join(parent, name)
  let enterable = isDirectory
  if (!enterable && isSymbolicLink) {
    try {
      enterable = (await raceAbort(sftpStat(sftp, path), signal)).isDirectory()
    } catch (error) {
      if (signal?.aborted === true) throw asError(signal.reason)
      // A broken or unreadable link is not enterable; skip it silently.
      return null
    }
  }
  if (!enterable) return null
  return { name, path, hidden: name.startsWith('.') }
}

/** One probed row of a local level: a directory, a symlink to one, or nothing. */
async function localDirectoryRow(
  parent: string,
  name: string,
  isDirectory: boolean,
  isSymbolicLink: boolean,
  signal?: AbortSignal,
): Promise<DirectoryEntry | null> {
  const path = join(parent, name)
  let enterable = isDirectory
  if (!enterable && isSymbolicLink) {
    try {
      enterable = (await raceAbort(stat(path), signal)).isDirectory()
    } catch (error) {
      if (signal?.aborted === true) throw asError(signal.reason)
      return null
    }
  }
  if (!enterable) return null
  return { name, path, hidden: name.startsWith('.') }
}

/** A streamed local dirent reduced to the facts the bounded window keeps. */
interface DirentCandidate {
  name: string
  isDirectory: boolean
  isSymbolicLink: boolean
}

/** Directory-picker browse backend registered as `ctx.directoryPicker`. */
export class SshDirectoryPicker extends DirectoryPicker {
  static inject = ['ssh']
  static Config: z<Config> = z.object({
    maxEntries: z.natural().min(1).default(1e3),
    remoteLabel: z.string(),
    localLabel: z.string(),
  })

  private readonly config: ResolvedConfig
  private readonly localHome: string
  private readonly remoteHomePromise: Promise<string>
  private readonly browseCapability: DirectoryPickerBrowseCapability

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    this.localHome = homedir()
    this.remoteHomePromise = this.resolveRemoteHome()
    this.browseCapability = {
      kind: 'browse',
      list: (path?: string, signal?: AbortSignal) => this.list(path, signal),
      createDirectory: (path: string, name: string) => this.createDirectory(path, name),
    }
  }

  /** The browse interaction capability (stable for the service lifetime). */
  override capability(): DirectoryPickerCapability {
    return this.browseCapability
  }

  /**
   * List one directory level.
   * @param path - absolute directory to list; absent lists the local home on
   *   Windows hosts (the add-workspace dialog opens on the local machine) and
   *   the remote home elsewhere.
   * @param signal - caller lifetime; abort stops the scan and rejects.
   * @returns the level's listing with ancestry.
   */
  async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    if (path === undefined) {
      return this.dualMode ? this.listLocal(this.localHome, signal) : this.listRemote(await this.remoteHome(), signal)
    }
    if (this.isLocalPath(path)) return this.listLocal(resolve(path), signal)
    if (posix.isAbsolute(path)) return this.listRemote(path, signal)
    throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`)
  }

  /**
   * Create one child directory under an existing parent.
   * @param path - absolute existing parent directory.
   * @param name - single non-blank path segment (no separators, not `.`/`..`).
   * @returns the created directory's absolute path.
   */
  async createDirectory(path: string, name: string): Promise<string> {
    if (name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new DirectoryPickerError('directory-create-failed', join(path, name), `"${name}" is not a single path segment`)
    }
    if (this.isLocalPath(path)) return this.createLocalDirectory(path, name)
    if (posix.isAbsolute(path)) return this.createRemoteDirectory(path, name)
    throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`)
  }

  /** Whether the host platform keeps a reachable local filesystem beside the remote one. */
  private get dualMode(): boolean {
    return process.platform === 'win32'
  }

  /** Whether `path` addresses the local filesystem (Windows hosts only). */
  private isLocalPath(path: string): boolean {
    return this.dualMode && fullyQualifiedWin32(path)
  }

  /** The remote host account's home directory (fallback: the configured remote cwd). */
  private async resolveRemoteHome(): Promise<string> {
    try {
      const environment = await this.ctx.ssh.getRemoteEnvironment()
      const home = environment.HOME
      if (typeof home === 'string' && home.trim().length > 0) return home
    } catch {
      // A dead connection falls back below; the listing itself still surfaces it.
    }
    return this.ctx.ssh.cwd
  }

  /** Await the cached remote home. */
  private remoteHome(): Promise<string> {
    return this.remoteHomePromise
  }

  /** The pinned remote entry's display name. */
  private remoteEntryLabel(): string {
    if (this.config.remoteLabel !== undefined) return this.config.remoteLabel
    return `Remote host ${this.ctx.ssh.endpoint}`
  }

  /** The pinned local entry's display name. */
  private localEntryLabel(): string {
    if (this.config.localLabel !== undefined) return this.config.localLabel
    return 'Local host'
  }

  /** List one remote level over the shared SFTP channel. */
  private async listRemote(target: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const sftp = await this.ctx.ssh.getSftp()
    const home = await this.remoteHome()
    const keep = this.config.maxEntries + 1
    const window: DirentCandidate[] = []
    let evicted = false
    try {
      const listed = await raceAbort(sftpReadDir(sftp, target), signal)
      for (const entry of listed) {
        signal?.throwIfAborted()
        if (!entry.attrs.isDirectory() && !entry.attrs.isSymbolicLink()) continue
        if (boundedInsert(window, {
          name: entry.filename,
          isDirectory: entry.attrs.isDirectory(),
          isSymbolicLink: entry.attrs.isSymbolicLink(),
        }, keep)) evicted = true
      }
    } catch (error) {
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
    }
    const entries: DirectoryEntry[] = []
    let truncated = evicted
    for (const candidate of window) {
      signal?.throwIfAborted()
      const row = await remoteDirectoryRow(sftp, target, candidate.name, candidate.isDirectory, candidate.isSymbolicLink, signal)
      if (row === null) continue
      if (entries.length === this.config.maxEntries) {
        truncated = true
        break
      }
      entries.push(row)
    }
    return {
      path: target,
      home,
      crumbs: ancestryCrumbs(target, posix.dirname, posix.basename),
      entries,
      truncated,
    }
  }

  /** List one local level over the host filesystem (Windows hosts only). */
  private async listLocal(target: string, signal?: AbortSignal): Promise<DirectoryListing> {
    const home = this.localHome
    const keep = this.config.maxEntries + 1
    const window: DirentCandidate[] = []
    let evicted = false
    try {
      const opening = opendir(target)
      const level = await raceAbort(opening, signal).catch((error) => {
        opening.then((dir) => dir.close().catch(() => {}), () => {})
        throw error
      })
      try {
        for (;;) {
          const dirent = await raceAbort(level.read(), signal)
          if (dirent === null) break
          if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
          if (boundedInsert(window, {
            name: dirent.name,
            isDirectory: dirent.isDirectory(),
            isSymbolicLink: dirent.isSymbolicLink(),
          }, keep)) evicted = true
        }
      } finally {
        const closing = level.close()
        if (signal?.aborted === true) closing.catch(() => {})
        else await closing
      }
    } catch (error) {
      signal?.throwIfAborted()
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
    }
    const entries: DirectoryEntry[] = []
    let truncated = evicted
    for (const candidate of window) {
      signal?.throwIfAborted()
      const row = await localDirectoryRow(target, candidate.name, candidate.isDirectory, candidate.isSymbolicLink, signal)
      if (row === null) continue
      if (entries.length === this.config.maxEntries) {
        truncated = true
        break
      }
      entries.push(row)
    }
    return {
      path: target,
      home,
      crumbs: ancestryCrumbs(target, win32.dirname, win32.basename),
      entries,
      truncated,
    }
  }

  /** Create one child directory on the remote host (SFTP mkdir, non-recursive). */
  private async createRemoteDirectory(path: string, name: string): Promise<string> {
    if (!posix.isAbsolute(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`)
    }
    const target = posix.join(path, name)
    const sftp = await this.ctx.ssh.getSftp()
    try {
      const existing = await new Promise<Stats | undefined>((resolvePromise) => {
        sftp.lstat(target, (error, value) => { if (error !== undefined) resolvePromise(undefined); else resolvePromise(value) })
      })
      if (existing !== undefined) throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
    } catch (error) {
      if (error instanceof DirectoryPickerError) throw error
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
    try {
      await new Promise<void>((resolvePromise, reject) => {
        sftp.mkdir(target, (error) => { if (error !== undefined) reject(error); else resolvePromise() })
      })
      return target
    } catch (error) {
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
  }

  /** Create one child directory on the local filesystem (Windows hosts only). */
  private async createLocalDirectory(path: string, name: string): Promise<string> {
    if (!fullyQualifiedWin32(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`)
    }
    const parent = resolve(path)
    const target = join(parent, name)
    try {
      await mkdir(target)
      return target
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'EEXIST') {
        throw new DirectoryPickerError('directory-exists', target, `${target} already exists`)
      }
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
    }
  }
}

export default SshDirectoryPicker
