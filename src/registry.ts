/**
 * Connection registry for the web channel: persisted multi-connection state
 * plus `~/.ssh/config` awareness. The `ssh://<id>/<path>` routing used by the
 * directory browser and (later) the fs/subprocess providers resolves through
 * this service, so every surface shares one live connection per entry.
 * @module dsh-ssh/registry
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SshConnection } from './connection.ts'
import type { SshConnectionSpec } from './connection.ts'

/** Registry plugin config. */
export interface RegistryConfig {
  /** Persisted state file; defaults to `<dsh home>/dsh-ssh-connections.json`. */
  stateFile?: string
}

/** One `~/.ssh/config` Host block's effective properties. */
interface SshConfigBlock {
  hostName?: string
  user?: string
  port?: number
  identityFiles: string[]
  proxyJump: string[]
}

/** Client-facing view of one registered connection (no secrets). */
export interface SshConnectionView {
  id: string
  label: string
  host: string
  port: number
  username: string
  cwd?: string
  auth: 'password' | 'key' | 'agent'
  jumpHosts: string[]
}

/** One exact `~/.ssh/config` Host alias as the sidebar lists it. */
export interface SshConfigHostView {
  /** The exact alias as spelled in the config (no wildcards). */
  alias: string
  /** The resolved HostName, or the alias when none is configured. */
  host: string
  /** The block's User; empty when the config does not specify one. */
  username: string
  port: number
  /** Whether the block lists at least one IdentityFile. */
  identityFile: boolean
  /** Whether the block lists a ProxyJump chain. */
  jump: boolean
}

/** One ProxyJump hop after `~/.ssh/config` resolution. */
export interface ResolvedJump {
  host: string
  port: number
  username: string
  privateKeyPath?: string
  agent?: string
}

/** The result of resolving a host alias against `~/.ssh/config`. */
export interface ResolvedSshConfig {
  host: string
  username: string
  port: number
  privateKeyPaths: string[]
  jump: ResolvedJump[]
}

/** Payload the channel accepts for a new connection. */
export interface ConnectionInput {
  label?: string
  host: string
  port?: number
  username?: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  agent?: string
  jump?: ResolvedJump[]
  cwd?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sshRegistry: SshRegistry
  }
}

/** The `ssh://<id>/<path>` routing result shared by browsers and providers. */
export interface SshRoute {
  connection: SshConnection
  /** Absolute POSIX path on the remote host. */
  path: string
}

/** Parse `ssh://<connId>/<abs>` (the workspace/cwd spelling of a remote path). */
export function parseSshRoute(value: string): { id: string; path: string } | null {
  if (!value.startsWith('ssh://')) return null
  const rest = value.slice('ssh://'.length)
  const separator = rest.indexOf('/')
  if (separator <= 0) return null
  const id = rest.slice(0, separator)
  const path = rest.slice(separator)
  if (!/^[A-Za-z0-9._-]+$/.test(id) || !posix.isAbsolute(path)) return null
  return { id, path }
}

/** Expand `~`/`~/` (or `%d`-free spellings) in an ssh-config file path. */
function expandHome(path: string): string {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1))
  return path
}

/** Read and parse `~/.ssh/config` into pattern → block entries. */
function readSshConfig(path: string): Array<{ patterns: string[]; block: SshConfigBlock }> {
  const entries: Array<{ patterns: string[]; block: SshConfigBlock }> = []
  if (!existsSync(path)) return entries
  let current: { patterns: string[]; block: SshConfigBlock } | undefined
  const push = (): void => {
    if (current === undefined) return
    current.patterns = current.patterns.filter(pattern => pattern.trim() !== '')
    if (current.patterns.length > 0) entries.push(current)
    current = undefined
  }
  try {
    for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.length === 0 || line.startsWith('#')) continue
      const [keyword, ...rest] = line.split(/\s+/)
      const value = rest.join(' ').trim()
      if (keyword === undefined || value === '') continue
      const key = keyword.toLowerCase()
      if (key === 'host') {
        push()
        current = { patterns: value.split(/\s+/), block: { identityFiles: [], proxyJump: [] } }
        continue
      }
      if (current === undefined) continue
      if (key === 'hostname') current.block.hostName = value
      else if (key === 'user') current.block.user = value
      else if (key === 'port') {
        const port = Number(value)
        if (Number.isInteger(port) && port > 0 && port <= 65535) current.block.port = port
      } else if (key === 'identityfile') current.block.identityFiles.push(expandHome(value))
      else if (key === 'proxyjump') current.block.proxyJump = value.split(',').map(entry => entry.trim()).filter(entry => entry !== '' && entry.toLowerCase() !== 'none')
    }
    push()
  } catch {
    // An unreadable ssh config is the same as an absent one for discovery.
  }
  return entries
}

/** Match one hostname against an OpenSSH Host pattern (exact or trailing `*`). */
function patternMatches(pattern: string, host: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('*')) return host.startsWith(pattern.slice(0, -1))
  return pattern.toLowerCase() === host.toLowerCase()
}

/** An exact Host alias (no `*` / `?` wildcard, no `!` negation) listable in the UI. */
function isExactAlias(pattern: string): boolean {
  return pattern !== '' && !/[*?!]/.test(pattern)
}

/** Parse one `[user@]host[:port]` ProxyJump entry. */
function parseJumpEntry(entry: string): { host: string; username?: string; port?: number } {
  let rest = entry
  let username: string | undefined
  let port: number | undefined
  const at = rest.lastIndexOf('@')
  if (at >= 0) {
    username = rest.slice(0, at)
    rest = rest.slice(at + 1)
  }
  const colon = rest.lastIndexOf(':')
  if (colon >= 0) {
    const portValue = Number(rest.slice(colon + 1))
    if (Number.isInteger(portValue) && portValue > 0 && portValue <= 65535) {
      port = portValue
      rest = rest.slice(0, colon)
    }
  }
  return {
    host: rest,
    ...(username !== undefined ? { username } : {}),
    ...(port !== undefined ? { port } : {}),
  }
}

/**
 * Connection registry service. Persisted entries live in a JSON state file;
 * live `SshConnection` instances are created lazily and share one chain per
 * entry. Secret fields (password, passphrase) are persisted verbatim because
 * the operator asked for remembered connections — the file lives under the
 * DSH home directory.
 */
export class SshRegistry extends Service {
  static Config: z<RegistryConfig> = z.object({
    stateFile: z.string(),
  })

  private readonly stateFile: string
  private readonly sshConfigPath = join(homedir(), '.ssh', 'config')
  private readonly specs = new Map<string, SshConnectionSpec>()
  private readonly live = new Map<string, SshConnection>()
  private nextId = 1
  private writeTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: RegistryConfig) {
    super(ctx, 'sshRegistry')
    this.stateFile = config.stateFile ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-ssh-connections.json')
    this.load()
  }

  /** All registered connections as secret-free views, in insertion order. */
  list(): SshConnectionView[] {
    return [...this.specs.values()].map(spec => this.viewOf(spec))
  }

  /** The live connection for one entry, created on first use. */
  get(id: string): SshConnection | undefined {
    const spec = this.specs.get(id)
    if (spec === undefined) return undefined
    let connection = this.live.get(id)
    if (connection === undefined) {
      connection = new SshConnection(spec)
      this.live.set(id, connection)
    }
    return connection
  }

  /** Resolve a `ssh://<id>/<path>` cwd/path into its live connection and remote path. */
  route(value: string): SshRoute | undefined {
    const parsed = parseSshRoute(value)
    if (parsed === null) return undefined
    const connection = this.get(parsed.id)
    if (connection === undefined) return undefined
    return { connection, path: parsed.path }
  }

  /** Validate, resolve, persist, and register one new connection. */
  add(input: ConnectionInput): { id: string; view: SshConnectionView } {
    const label = (input.label ?? '').trim() || `${input.username ?? ''}@${input.host}`.replace(/^@/, '')
    const host = input.host.trim()
    const username = (input.username ?? '').trim()
    if (host === '') throw new Error('dsh-ssh: host must be a non-empty string')
    if (username === '') throw new Error('dsh-ssh: username must be a non-empty string')
    const port = input.port ?? 22
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`dsh-ssh: port must be an integer in 1..65535: ${port}`)
    const cwd = (input.cwd ?? '').trim()
    if (cwd !== '' && !posix.isAbsolute(cwd)) throw new Error(`dsh-ssh: cwd must be an absolute POSIX path: ${cwd}`)
    for (const [index, hop] of (input.jump ?? []).entries()) {
      if (hop.host.trim() === '') throw new Error(`dsh-ssh: jump[${index}].host must be a non-empty string`)
    }
    const id = `c${this.nextId}`
    this.nextId += 1
    const spec: SshConnectionSpec = {
      id,
      label,
      host,
      port,
      username,
      ...(cwd === '' ? {} : { cwd }),
      jump: (input.jump ?? []).map(hop => ({
        host: hop.host,
        port: hop.port,
        username: hop.username,
        ...(hop.privateKeyPath !== undefined ? { privateKey: hop.privateKeyPath } : {}),
        ...(hop.agent !== undefined ? { agent: hop.agent } : {}),
      })),
    }
    if (input.password !== undefined && input.password !== '') spec.password = input.password
    if (input.privateKeyPath !== undefined && input.privateKeyPath !== '') spec.privateKeyPath = input.privateKeyPath
    if (input.passphrase !== undefined && input.passphrase !== '') spec.passphrase = input.passphrase
    if (input.agent !== undefined && input.agent !== '') spec.agent = input.agent
    this.specs.set(id, spec)
    void this.persist()
    return { id, view: this.viewOf(spec) }
  }

  /** Remove one entry and its live connection. Unknown ids are a no-op. */
  remove(id: string): boolean {
    const spec = this.specs.get(id)
    if (spec === undefined) return false
    this.specs.delete(id)
    const connection = this.live.get(id)
    if (connection !== undefined) {
      this.live.delete(id)
      connection.dispose()
    }
    void this.persist()
    return true
  }

  /** Test one input without persisting: connect, run `true`, and dispose. */
  async test(input: ConnectionInput): Promise<{ ok: true } | { ok: false; message: string }> {
    const spec: SshConnectionSpec = {
      id: 'test',
      label: 'test',
      host: input.host,
      port: input.port ?? 22,
      username: input.username ?? '',
      cwd: '/tmp',
      jump: (input.jump ?? []).map(hop => ({
        host: hop.host,
        port: hop.port,
        username: hop.username,
        ...(hop.privateKeyPath !== undefined ? { privateKey: hop.privateKeyPath } : {}),
        ...(hop.agent !== undefined ? { agent: hop.agent } : {}),
      })),
    }
    if (input.password !== undefined && input.password !== '') spec.password = input.password
    if (input.privateKeyPath !== undefined && input.privateKeyPath !== '') spec.privateKeyPath = input.privateKeyPath
    if (input.passphrase !== undefined && input.passphrase !== '') spec.passphrase = input.passphrase
    if (input.agent !== undefined && input.agent !== '') spec.agent = input.agent
    const connection = new SshConnection(spec)
    try {
      await connection.getClient()
      const outcome = await connection.exec('true')
      if (outcome.exitCode !== 0) throw new Error(outcome.stderr.trim() || `remote command failed with exit code ${String(outcome.exitCode)}`)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    } finally {
      connection.dispose()
    }
  }

  /** Resolve a hostname (possibly a `~/.ssh/config` alias) into its effective config. */
  resolveSshConfig(host: string, depth = 0): ResolvedSshConfig {
    return this.resolveAgainst(this.readConfigEntries(), host, depth)
  }

  /**
   * List the exact `~/.ssh/config` Host aliases for the sidebar, re-reading the
   * file on every call so edits between two openings are picked up. Wildcard
   * and negated patterns stay hidden; each alias carries its resolved
   * username/port plus IdentityFile / ProxyJump presence.
   */
  listConfigHosts(): SshConfigHostView[] {
    const entries = this.readConfigEntries()
    const seen = new Set<string>()
    const hosts: SshConfigHostView[] = []
    for (const entry of entries) {
      for (const pattern of entry.patterns) {
        if (!isExactAlias(pattern)) continue
        const key = pattern.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const resolved = this.resolveAgainst(entries, pattern, 0)
        hosts.push({
          alias: pattern,
          host: resolved.host,
          username: resolved.username,
          port: resolved.port,
          identityFile: resolved.privateKeyPaths.length > 0,
          jump: resolved.jump.length > 0,
        })
      }
    }
    return hosts
  }

  /** Re-read `~/.ssh/config`; an absent or unreadable file reads as empty. */
  private readConfigEntries(): Array<{ patterns: string[]; block: SshConfigBlock }> {
    return readSshConfig(this.sshConfigPath)
  }

  /** Resolve against one fixed snapshot of the config (jump hops share it). */
  private resolveAgainst(entries: Array<{ patterns: string[]; block: SshConfigBlock }>, host: string, depth: number): ResolvedSshConfig {
    const block = entries.find(entry => entry.patterns.some(pattern => patternMatches(pattern, host)))?.block
    const resolved: ResolvedSshConfig = {
      host: block?.hostName ?? host,
      username: block?.user ?? '',
      port: block?.port ?? 22,
      privateKeyPaths: block?.identityFiles ?? [],
      jump: [],
    }
    if (depth < 8) {
      for (const entry of block?.proxyJump ?? []) {
        const hop = parseJumpEntry(entry)
        const hopConfig = this.resolveAgainst(entries, hop.host, depth + 1)
        resolved.jump.push({
          host: hopConfig.host,
          port: hop.port ?? hopConfig.port,
          username: hop.username ?? (hopConfig.username !== '' ? hopConfig.username : resolved.username),
          ...(hopConfig.privateKeyPaths[0] !== undefined ? { privateKeyPath: hopConfig.privateKeyPaths[0] } : {}),
        })
      }
    }
    return resolved
  }

  /** Load persisted state; a missing or corrupt file starts empty. */
  private load(): void {
    try {
      if (!existsSync(this.stateFile)) return
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as { connections?: SshConnectionSpec[] }
      if (!Array.isArray(parsed.connections)) return
      let maxId = 0
      for (const spec of parsed.connections) {
        if (typeof spec !== 'object' || spec === null) continue
        if (typeof spec.id !== 'string' || typeof spec.host !== 'string' || typeof spec.username !== 'string') continue
        const numeric = /^c(\d+)$/.exec(spec.id)
        if (numeric !== null) maxId = Math.max(maxId, Number(numeric[1]))
        this.specs.set(spec.id, spec as SshConnectionSpec)
      }
      this.nextId = maxId + 1
    } catch (error) {
      this.ctx.logger.warn(`dsh-ssh: cannot load connection state from ${this.stateFile}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Persist the registry (serialized behind the previous write). */
  private persist(): Promise<void> {
    const snapshot = [...this.specs.values()].map(spec => ({ ...spec }))
    const write = async (): Promise<void> => {
      try {
        writeFileSync(this.stateFile, JSON.stringify({ connections: snapshot }, null, 2) + '\n', 'utf8')
      } catch (error) {
        this.ctx.logger.warn(`dsh-ssh: cannot persist connection state to ${this.stateFile}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.writeTail = this.writeTail.then(write, write)
    return this.writeTail
  }

  /** Project one spec into its secret-free wire view. */
  private viewOf(spec: SshConnectionSpec): SshConnectionView {
    const auth: SshConnectionView['auth'] = spec.agent !== undefined ? 'agent' : spec.password !== undefined ? 'password' : 'key'
    return {
      id: spec.id,
      label: spec.label,
      host: spec.host,
      port: spec.port,
      username: spec.username,
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      auth,
      jumpHosts: (spec.jump ?? []).map(hop => `${hop.username ?? spec.username}@${hop.host}:${hop.port ?? 22}`),
    }
  }
}

export default SshRegistry
