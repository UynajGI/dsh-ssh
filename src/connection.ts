/**
 * One standalone SSH connection owned by the connection registry (not the
 * `ctx.ssh` service): the same ProxyJump chain, auth, SFTP, and exec mechanics
 * as `SshRuntime`, but bound to a registry entry instead of the shared
 * service. The registry uses it for connection tests and per-connection
 * directory browsing; the `ssh://<id>/<path>` cwd routing in the providers
 * rides the same instances.
 * @module dsh-ssh/connection
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import { wrapCwd } from './runtime.ts'
import type { ExecOutcome, JumpConfig } from './runtime.ts'

/** One hop after auth and defaults are resolved. */
interface ResolvedHop {
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

/** A registry entry as persisted in the state file. */
export interface SshConnectionSpec {
  /** Stable registry id (`c1`, `c2`, …). */
  id: string
  /** Operator-facing display name. */
  label: string
  /** Target hostname or address. */
  host: string
  /** Target SSH port. */
  port: number
  /** Remote login user. */
  username: string
  /** Password authentication (stored verbatim; omit for key/agent auth). */
  password?: string
  /** Local path to a PEM identity file. */
  privateKeyPath?: string
  /** Passphrase for an encrypted private key. */
  passphrase?: string
  /** SSH agent socket path or the `pageant` sentinel for Windows. */
  agent?: string
  /** Ordered ProxyJump chain (same semantics as the ssh service). */
  jump?: JumpConfig[]
  /** Remote working directory; an absolute POSIX path, or absent to resolve lazily. */
  cwd?: string
  /** Socket connect timeout in milliseconds. */
  readyTimeout?: number
  /** TCP keepalive interval in milliseconds; 0 disables. */
  keepaliveInterval?: number
  /** TCP keepalive retry budget before the connection is considered dead. */
  keepaliveCountMax?: number
}

/** Read an identity value that is a local path to a PEM file. */
function readIdentityFile(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Build the ssh2 config for one hop, without the jump socket. */
function toConnectConfig(hop: ResolvedHop, agentFallback: string | undefined): ConnectConfig {
  const config: ConnectConfig = {
    host: hop.host,
    port: hop.port,
    username: hop.username,
    readyTimeout: hop.readyTimeout,
    keepaliveInterval: hop.keepaliveInterval,
    keepaliveCountMax: hop.keepaliveCountMax,
  }
  if (hop.password !== undefined) config.password = hop.password
  if (hop.privateKey !== undefined) config.privateKey = hop.privateKey
  if (hop.passphrase !== undefined) config.passphrase = hop.passphrase
  if (hop.agent !== undefined) config.agent = hop.agent
  else if (agentFallback !== undefined) config.agent = agentFallback
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

/** Host-key verifier accepting exactly the configured fingerprints/keys. */
function hostVerifierFor(knownHosts: readonly string[]): (key: Buffer) => boolean {
  return (key: Buffer): boolean => {
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64')}`
    const raw = key.toString('base64')
    return knownHosts.some((entry) => {
      const token = entry.trim().split(/\s+/).at(-1) ?? ''
      return token === fingerprint || token === raw
    })
  }
}

/** A registry-owned live SSH connection (jump chain + shared SFTP). */
export class SshConnection {
  readonly id: string
  readonly label: string
  readonly endpoint: string

  private readonly hops: ResolvedHop[]
  private readonly strict: boolean
  private readonly knownHosts: string[]
  private clients: Client[] = []
  private ready: Promise<Client> | undefined
  private sftp: SFTPWrapper | undefined
  private sftpOpening: Promise<SFTPWrapper> | undefined
  private remoteEnvironment: Promise<Record<string, string>> | undefined
  private disposed = false

  /** The transport's default remote working directory. */
  get cwd(): string {
    return this.spec.cwd ?? '/root'
  }

  /** Build the hop chain from a registry spec (auth defaults fall down the chain). */
  constructor(readonly spec: SshConnectionSpec) {
    this.id = spec.id
    this.label = spec.label
    this.endpoint = `${spec.username}@${spec.host}`
    this.strict = false
    this.knownHosts = []
    const readyTimeout = spec.readyTimeout ?? 20_000
    const keepaliveInterval = spec.keepaliveInterval ?? 0
    const keepaliveCountMax = spec.keepaliveCountMax ?? 3
    const parent: ResolvedHop = {
      host: spec.host,
      port: spec.port,
      username: spec.username,
      readyTimeout,
      keepaliveInterval,
      keepaliveCountMax,
    }
    if (spec.password !== undefined) parent.password = spec.password
    if (spec.privateKeyPath !== undefined) parent.privateKey = readIdentityFile(spec.privateKeyPath)
    if (spec.passphrase !== undefined) parent.passphrase = spec.passphrase
    if (spec.agent !== undefined) parent.agent = spec.agent
    this.hops = [...(spec.jump ?? []).map((jump): ResolvedHop => {
      const hop: ResolvedHop = {
        host: jump.host ?? parent.host,
        port: jump.port ?? parent.port,
        username: jump.username ?? parent.username,
        readyTimeout: jump.readyTimeout ?? readyTimeout,
        keepaliveInterval: jump.keepaliveInterval ?? keepaliveInterval,
        keepaliveCountMax: jump.keepaliveCountMax ?? keepaliveCountMax,
      }
      if (jump.password !== undefined) hop.password = jump.password
      if (jump.privateKey !== undefined) hop.privateKey = jump.privateKey.includes('-----BEGIN') ? jump.privateKey : readIdentityFile(jump.privateKey)
      if (jump.passphrase !== undefined) hop.passphrase = jump.passphrase
      if (jump.agent !== undefined) hop.agent = jump.agent
      return hop
    }), parent]
  }

  /** Release the chain and the shared SFTP channel. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.sftp !== undefined) {
      const sftp = this.sftp
      this.sftp = undefined
      try { sftp.end() } catch { /* already quiescent */ }
    }
    const clients = this.clients
    this.clients = []
    for (const client of clients.reverse()) {
      try { client.end() } catch { /* already quiescent */ }
    }
  }

  /**
   * Map a caller-supplied working directory onto this connection's host. The
   * rules mirror {@link SshRuntime.resolveRemoteCwd}: a POSIX absolute path is
   * already remote, while a Windows drive/UNC path or the absent cwd falls
   * back to the registry entry's configured remote cwd.
   */
  resolveRemoteCwd(cwd: string | undefined): string {
    const fallback = this.cwd
    if (cwd === undefined) return fallback
    if (cwd.startsWith('ssh://')) {
      throw new Error('dsh-ssh: ssh:// working directories must be routed through ctx.subprocess or ctx.fs; ctx.ssh cannot choose a registry connection')
    }
    if (posix.isAbsolute(cwd)) return cwd
    if (/^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('//') || cwd.startsWith('\\\\')) return fallback
    return posix.resolve(fallback, cwd)
  }

  /** The authenticated target client after the jump chain succeeds. */
  async getClient(signal?: AbortSignal): Promise<Client> {
    signal?.throwIfAborted()
    if (this.disposed) throw new Error(`dsh-ssh: connection "${this.label}" is disposed`)
    this.ready ??= this.open()
    const client = await this.ready
    signal?.throwIfAborted()
    if (this.disposed) throw new Error(`dsh-ssh: connection "${this.label}" is disposed`)
    return client
  }

  /** The shared SFTP channel, opened lazily once per connection. */
  async getSftp(signal?: AbortSignal): Promise<SFTPWrapper> {
    if (this.disposed) throw new Error(`dsh-ssh: connection "${this.label}" is disposed`)
    if (this.sftp !== undefined) return this.sftp
    this.sftpOpening ??= this.openSftp(signal)
    const sftp = await this.sftpOpening
    if (this.sftp === undefined) this.sftp = sftp
    return sftp
  }

  /** The remote login environment, read once and cached. */
  getRemoteEnvironment(signal?: AbortSignal): Promise<Record<string, string>> {
    if (this.disposed) return Promise.reject(new Error(`dsh-ssh: connection "${this.label}" is disposed`))
    this.remoteEnvironment ??= this.readRemoteEnvironment(signal)
    return this.remoteEnvironment
  }

  /** Run one control-plane command with collected output. */
  async exec(command: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<ExecOutcome> {
    opts?.signal?.throwIfAborted()
    const client = await this.getClient(opts?.signal)
    const resolvedCwd = opts?.cwd !== undefined ? this.resolveRemoteCwd(opts.cwd) : undefined
      const text = resolvedCwd !== undefined ? wrapCwd(resolvedCwd, command) : command
    const outcome = await new Promise<ExecOutcome>((resolve, reject) => {
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
      const onAbort = (): void => { channel?.close() }
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

  private async openSftp(signal?: AbortSignal): Promise<SFTPWrapper> {
    const client = await this.getClient(signal)
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

  private async readRemoteEnvironment(signal?: AbortSignal): Promise<Record<string, string>> {
    const { exitCode, stdout } = await this.exec('env -0', signal === undefined ? undefined : { signal })
    if (exitCode !== 0) throw new Error(`dsh-ssh: cannot read the remote environment of "${this.label}"`)
    const environment: Record<string, string> = {}
    for (const entry of stdout.split('\0')) {
      if (entry.length === 0) continue
      const separator = entry.indexOf('=')
      if (separator <= 0) continue
      environment[entry.slice(0, separator)] = entry.slice(separator + 1)
    }
    return environment
  }

  private async open(): Promise<Client> {
    const clients: Client[] = []
    try {
      for (let index = 0; index < this.hops.length; index += 1) {
        const hop = this.hops[index] as ResolvedHop
        const previous = clients[index - 1]
        const client = new Client()
        clients.push(client)
        const config = toConnectConfig(hop, undefined)
        if (this.strict) config.hostVerifier = hostVerifierFor(this.knownHosts)
        if (previous === undefined) {
          await connectReady(client, config)
        } else {
          const socket = await forwardThrough(previous, hop.host, hop.port)
          await connectReady(client, { ...config, sock: socket })
        }
      }
      this.clients = clients
      return clients[clients.length - 1] as Client
    } catch (error) {
      for (const client of clients.reverse()) {
        try { client.end() } catch { /* best effort */ }
      }
      throw error
    }
  }
}
