/**
 * Shared ownership of one SSH execution world. Capability adapters await the same
 * authenticated connection (reached through an optional ProxyJump chain), so
 * filesystem and process operations inhabit one remote host. Auth, keepalive,
 * host-key verification, and the jump chain mirror the portable subset of an
 * OpenSSH `~/.ssh/config` `Host` block.
 * @module @deepseek-ai/dsh-ssh
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/**
 * Quote one argument for a POSIX login shell: single quotes with the only
 * escaping a single-quoted string needs. Identical in spirit to the E2B
 * adapter's helper so both remote providers share one quoting rule.
 * @param value - exact argument value to preserve.
 * @returns a single shell word with no interpolation.
 */
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll('\'', '\'"\'"\'')}'`
}

/**
 * Wrap a remote command so it runs from the configured working directory.
 * @param cwd - absolute remote working directory.
 * @param command - the remote command to run there.
 * @returns the `cd`-guarded command text.
 */
export function wrapCwd(cwd: string, command: string): string {
  return `cd -- ${quoteShellArg(cwd)} && ${command}`
}

/** One hop in a ProxyJump chain. */
export interface JumpConfig {
  /** Remote hostname or address, resolved by the previous hop or the local host. */
  host?: string
  /** Remote SSH port; defaults to the parent host's port (22 for the top level). */
  port?: number
  /** Remote user; defaults to the parent host's username. */
  username?: string
  /** Password authentication for this hop. */
  password?: string
  /** PEM private key content or a local path to an identity file. */
  privateKey?: string
  /** Passphrase for an encrypted private key. */
  passphrase?: string
  /** SSH agent socket path or the `pageant` sentinel for Windows. */
  agent?: string
  /** Socket connect timeout in milliseconds; defaults to the parent's. */
  readyTimeout?: number
  /** TCP keepalive interval in milliseconds; 0 disables. */
  keepaliveInterval?: number
  /** TCP keepalive retry budget before the connection is considered dead. */
  keepaliveCountMax?: number
}

/** Configuration for the shared SSH connection owner. */
export interface Config {
  /** Target hostname or address. */
  host?: string
  /** Target SSH port. */
  port?: number
  /** Remote login user for the target host and default for unset jump users. */
  username?: string
  /** Password authentication. */
  password?: string
  /** PEM private key content or a local path to an identity file. */
  privateKey?: string
  /** Passphrase for an encrypted private key. */
  passphrase?: string
  /** SSH agent socket path or the `pageant` sentinel for Windows. */
  agent?: string
  /**
   * Ordered ProxyJump chain. The first hop is reached from the local host;
   * each following hop is reached through the previous one; the target host is
   * reached through the last hop. Every hop's own auth defaults fall back to
   * the target's when omitted.
   */
  jump?: JumpConfig[]
  /** Remote working directory shared by provider adapters; must be an absolute POSIX path. */
  cwd?: string
  /** Socket connect timeout in milliseconds. */
  readyTimeout?: number
  /** TCP keepalive interval in milliseconds; 0 disables. */
  keepaliveInterval?: number
  /** TCP keepalive retry budget before the connection is considered dead. */
  keepaliveCountMax?: number
  /** When true, reject a host key that does not match an entry in {@link knownHosts}. */
  strictHostKeyChecking?: boolean
  /** Trusted host keys as `SHA256:<base64>` fingerprints or raw base64 public keys. */
  knownHosts?: string[]
}

/** Resolved config with every default filled by Schemastery before construction. */
interface ResolvedConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  agent?: string
  jump: JumpConfig[]
  cwd: string
  readyTimeout: number
  keepaliveInterval: number
  keepaliveCountMax: number
  strictHostKeyChecking: boolean
  knownHosts: string[]
}

/** One connection hop after auth and defaults are resolved. */
interface ResolvedHost {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string | Buffer
  passphrase?: string
  agent?: string
  readyTimeout: number
  keepaliveInterval: number
  keepaliveCountMax: number
}

/** Collected result of one control-plane command. */
export interface ExecOutcome {
  /** Exit code; null when the command died from a signal. */
  exitCode: number | null
  /** Terminating signal; null on normal exit. */
  signal: string | null
  /** Collected standard output. */
  stdout: string
  /** Collected standard error. */
  stderr: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ssh: SshRuntime
  }
}

/** Reads an identity value that is either PEM content or a local identity-file path. */
function resolvePrivateKey(value: string): string | Buffer {
  return value.includes('-----BEGIN') ? value : readFileSync(value, 'utf8')
}

/**
 * Build the host-key verifier for strict checking: accept only a key whose
 * SHA256 fingerprint or raw base64 encoding matches a known-hosts entry.
 * @param knownHosts - configured trusted fingerprints or keys.
 * @returns a verifier accepting exactly the matching keys.
 */
function hostVerifierFor(knownHosts: readonly string[]): (key: Buffer) => boolean {
  return (key: Buffer): boolean => {
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64')}`
    const raw = key.toString('base64')
    return knownHosts.some((entry) => {
      // A known_hosts line is "<host> <keytype> <token>"; the token is the field that varies.
      const token = entry.trim().split(/\s+/).at(-1) ?? ''
      return token === fingerprint || token === raw
    })
  }
}

/** OpenSSH's default identity probe order, used when no auth is configured. */
const DEFAULT_IDENTITY_FILES = ['.ssh/id_ed25519', '.ssh/id_ecdsa', '.ssh/id_rsa']

/**
 * The first existing OpenSSH default identity, mirroring the ssh client's own
 * probe: a hop with no password, key, or agent configured would otherwise be
 * rejected by every server because ssh2 never tries default key files.
 */
export function defaultIdentity(): string | undefined {
  for (const candidate of DEFAULT_IDENTITY_FILES) {
    const expanded = join(homedir(), candidate)
    if (existsSync(expanded)) return readFileSync(expanded, 'utf8')
  }
  return undefined
}

/** Resolve auth and defaults into one connection hop. */
function resolveHost(config: ResolvedConfig): ResolvedHost {
  const host: ResolvedHost = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: config.readyTimeout,
    keepaliveInterval: config.keepaliveInterval,
    keepaliveCountMax: config.keepaliveCountMax,
  }
  if (config.password !== undefined) host.password = config.password
  if (config.privateKey !== undefined) host.privateKey = resolvePrivateKey(config.privateKey)
  if (config.passphrase !== undefined) host.passphrase = config.passphrase
  if (config.agent !== undefined) host.agent = config.agent
  return host
}

/** Resolve one jump hop with auth and defaults falling back to the parent. */
function resolveJump(jump: JumpConfig, parent: ResolvedConfig): ResolvedHost {
  const host: ResolvedHost = {
    host: jump.host ?? parent.host,
    port: jump.port ?? parent.port,
    username: jump.username ?? parent.username,
    readyTimeout: jump.readyTimeout ?? parent.readyTimeout,
    keepaliveInterval: jump.keepaliveInterval ?? parent.keepaliveInterval,
    keepaliveCountMax: jump.keepaliveCountMax ?? parent.keepaliveCountMax,
  }
  if (jump.password !== undefined) host.password = jump.password
  if (jump.privateKey !== undefined) host.privateKey = resolvePrivateKey(jump.privateKey)
  if (jump.passphrase !== undefined) host.passphrase = jump.passphrase
  if (jump.agent !== undefined) host.agent = jump.agent
  return host
}

/** Shape the ssh2 connection config for one hop, without the jump socket. */
function toConnectConfig(host: ResolvedHost, strict: boolean, knownHosts: readonly string[]): ConnectConfig {
  const config: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: host.readyTimeout,
    keepaliveInterval: host.keepaliveInterval,
    keepaliveCountMax: host.keepaliveCountMax,
  }
  if (host.password !== undefined) config.password = host.password
  if (host.privateKey !== undefined) config.privateKey = host.privateKey
  if (host.passphrase !== undefined) config.passphrase = host.passphrase
  if (host.agent !== undefined) config.agent = host.agent
  if (strict) config.hostVerifier = hostVerifierFor(knownHosts)
  if (config.password === undefined && config.privateKey === undefined && config.agent === undefined) {
    const identity = defaultIdentity()
    if (identity !== undefined) config.privateKey = identity
  }
  return config
}

/** Resolve once the client reaches its ready state. */
function connectReady(client: Client, config: ConnectConfig): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onReady = (): void => { cleanup(); resolve() }
    const onError = (error: Error): void => { cleanup(); reject(error) }
    const cleanup = (): void => {
      client.removeListener('ready', onReady)
      client.removeListener('error', onError)
    }
    client.once('ready', onReady)
    client.once('error', onError)
    client.connect(config)
  })
}

/** Open a direct-tcpip channel through one already-connected hop. */
function forwardThrough(client: Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (error, channel) => {
      if (error !== undefined) reject(error)
      else resolve(channel)
    })
  })
}

/** SSH connection owner registered as `ctx.ssh`. */
export class SshRuntime extends Service {
  static Config: z<Config> = z.object({
    host: z.string().required(),
    port: z.number().default(22),
    username: z.string().required(),
    password: z.string(),
    privateKey: z.string(),
    passphrase: z.string(),
    agent: z.string(),
    jump: z.array(z.object({
      host: z.string().required(),
      port: z.number(),
      username: z.string(),
      password: z.string(),
      privateKey: z.string(),
      passphrase: z.string(),
      agent: z.string(),
      readyTimeout: z.number(),
      keepaliveInterval: z.number(),
      keepaliveCountMax: z.number(),
    })).default([]),
    cwd: z.string().required(),
    readyTimeout: z.number().default(45_000),
    keepaliveInterval: z.number().default(0),
    keepaliveCountMax: z.number().default(3),
    strictHostKeyChecking: z.boolean().default(false),
    knownHosts: z.array(z.string()).default([]),
  })

  /** Validated remote working directory shared by provider adapters. */
  readonly cwd: string

  /** Human-readable connection target for UI surfaces (`username@host`). */
  readonly endpoint: string

  private readonly config: ResolvedConfig
  private readonly hosts: ResolvedHost[]
  private clients: Client[] = []
  private ready: Promise<Client> | undefined
  private sftp: SFTPWrapper | undefined
  private sftpOpening: Promise<SFTPWrapper> | undefined
  private remoteEnvironment: Promise<Record<string, string>> | undefined
  private disposed = false

  /** Validate config, resolve the jump chain, and bind the disposal policy. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'ssh')
    const resolved = config as ResolvedConfig
    this.validate(resolved)
    this.config = resolved
    this.cwd = resolved.cwd
    this.endpoint = `${resolved.username}@${resolved.host}`
    this.hosts = [...resolved.jump.map(jump => resolveJump(jump, resolved)), resolveHost(resolved)]

    ctx.effect(() => async () => {
      this.disposed = true
      if (this.sftp !== undefined) {
        const sftp = this.sftp
        this.sftp = undefined
        try {
          sftp.end()
        } catch (_alreadyEnded) {
          // A closed SFTP channel is already quiescent.
        }
      }
      const clients = this.clients
      this.clients = []
      // End the target first so its channel closes before the jump sockets it rode.
      for (const client of clients.reverse()) {
        try {
          client.end()
        } catch (_alreadyEnded) {
          // A client that already ended is already quiescent.
        }
      }
    }, 'ssh teardown')
  }

  /**
   * Return the shared live connection after the jump chain and auth succeed.
   * @returns the authenticated target client.
   * @throws when connection, jump, or authentication fails, or when disposing.
   */
  async getClient(): Promise<Client> {
    if (this.disposed) throw new Error('SSH service is disposing')
    this.ready ??= this.open()
    const client = await this.ready
    if (this.disposed) throw new Error('SSH service is disposing')
    return client
  }

  /**
   * Return the shared SFTP channel, opened lazily once per connection. A
   * closed connection invalidates it so the next call reopens.
   * @returns the live SFTP wrapper.
   */
  async getSftp(): Promise<SFTPWrapper> {
    if (this.disposed) throw new Error('SSH service is disposing')
    if (this.sftp !== undefined) return this.sftp
    this.sftpOpening ??= this.openSftp()
    const sftp = await this.sftpOpening
    if (this.sftp === undefined) this.sftp = sftp
    return sftp
  }

  private async openSftp(): Promise<SFTPWrapper> {
    const client = await this.getClient()
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, value) => {
        if (error !== undefined) reject(error)
        else resolve(value)
      })
    })
    const invalidate = (): void => {
      this.sftp = undefined
      this.sftpOpening = undefined
    }
    sftp.on('close', invalidate)
    sftp.on('end', invalidate)
    return sftp
  }

  /**
   * Return the remote login environment, read once per connection and cached.
   * The login environment is stable for the connection lifetime, so adapters
   * avoid one control command per spawned process.
   * @returns the remote environment as name/value entries.
   */
  getRemoteEnvironment(): Promise<Record<string, string>> {
    if (this.disposed) return Promise.reject(new Error('SSH service is disposing'))
    this.remoteEnvironment ??= this.readRemoteEnvironment()
    return this.remoteEnvironment
  }

  private async readRemoteEnvironment(): Promise<Record<string, string>> {
    const { exitCode, stdout } = await this.exec('env -0')
    if (exitCode !== 0) throw new Error('dsh-ssh: cannot read the remote environment')
    const environment: Record<string, string> = {}
    for (const entry of stdout.split('\0')) {
      if (entry.length === 0) continue
      const separator = entry.indexOf('=')
      if (separator <= 0) continue
      environment[entry.slice(0, separator)] = entry.slice(separator + 1)
    }
    return environment
  }

  /**
   * Map a caller-supplied working directory onto the remote host. The harness
   * hands providers the session cwd, which is a local path when the harness
   * runs on the developer machine; a local absolute path (Windows drive, UNC)
   * or a relative path has no meaning on the remote host, so it is redirected
   * to the configured remote cwd. A POSIX absolute path is a remote path and
   * passes through unchanged.
   * @param cwd - the caller-supplied working directory, or `undefined` for the default.
   * @returns the remote working directory to execute in.
   */
  resolveRemoteCwd(cwd: string | undefined): string {
    if (cwd === undefined) return this.cwd
      if (cwd.startsWith('ssh://')) {
        throw new Error('dsh-ssh: ssh:// working directories must be routed through ctx.subprocess or ctx.fs; ctx.ssh cannot choose a registry connection')
      }
    if (posix.isAbsolute(cwd)) return cwd
    if (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('//') || cwd.startsWith('\\\\')) return this.cwd
    return posix.resolve(this.cwd, cwd)
  }

  /**
   * Run one control-plane command with collected output. Used by adapters for
   * executable lookup and canonical-path resolution, not for user work.
   * @param command - remote command text (already shell-quoted by the caller).
   * @param opts - optional working-directory override and cancellation.
   * @returns the collected exit facts and output.
   */
  async exec(command: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<ExecOutcome> {
    opts?.signal?.throwIfAborted()
    const client = await this.getClient()
    const resolvedCwd = opts?.cwd !== undefined ? this.resolveRemoteCwd(opts.cwd) : undefined
      const text = resolvedCwd !== undefined ? wrapCwd(resolvedCwd, command) : command
    const outcome = await new Promise<ExecOutcome>((resolve, reject) => {
      // Buffer whole chunks and decode once: SSH data events may split a
      // multi-byte UTF-8 character across two callbacks, so per-chunk
      // decoding would corrupt it.
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let settled = false
      let channel: ClientChannel | undefined
      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        })
      }
      const onAbort = (): void => {
        // Closing the channel ends the remote command; its close event reports the outcome.
        channel?.close()
      }
      const cleanup = (): void => { opts?.signal?.removeEventListener('abort', onAbort) }
      client.exec(text, { pty: false }, (error, stream) => {
        if (error !== undefined) { cleanup(); reject(error); return }
        channel = stream
        stream.on('data', (data: Buffer) => { stdoutChunks.push(data) })
        stream.stderr.on('data', (data: Buffer) => { stderrChunks.push(data) })
        stream.on('close', (code: number | null, signal: string | null) => { finish(code, signal) })
      })
      if (opts?.signal?.aborted === true) { onAbort(); return }
      opts?.signal?.addEventListener('abort', onAbort, { once: true })
    })
    opts?.signal?.throwIfAborted()
    return outcome
  }

  private validate(config: ResolvedConfig): void {
    if (config.host.trim().length === 0) throw new Error('dsh-ssh: host must be a non-empty string')
    if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
      throw new Error(`dsh-ssh: port must be an integer in 1..65535: ${config.port}`)
    }
    if (config.username.trim().length === 0) throw new Error('dsh-ssh: username must be a non-empty string')
    if (!posix.isAbsolute(config.cwd)) throw new Error(`dsh-ssh: cwd must be an absolute POSIX path: ${config.cwd}`)
    for (const [index, jump] of config.jump.entries()) {
      if ((jump.host ?? '').trim().length === 0) throw new Error(`dsh-ssh: jump[${index}].host must be a non-empty string`)
    }
  }

  private async open(): Promise<Client> {
    const clients: Client[] = []
    try {
      for (let index = 0; index < this.hosts.length; index += 1) {
        const host = this.hosts[index] as ResolvedHost
        const previous = clients[index - 1]
        const client = new Client()
        clients.push(client)
        const config = toConnectConfig(host, this.config.strictHostKeyChecking, this.config.knownHosts)
        if (previous === undefined) {
          await connectReady(client, config)
        } else {
          const socket = await forwardThrough(previous, host.host, host.port)
          await connectReady(client, { ...config, sock: socket })
        }
      }
      this.clients = clients
      return clients[clients.length - 1] as Client
    } catch (error) {
      for (const client of clients.reverse()) {
        try {
          client.end()
        } catch (_alreadyEnded) {
          // Best-effort teardown of the partial chain; the original error owns the failure.
        }
      }
      throw error
    }
  }
}

export default SshRuntime
