/** SSH PTY allocation and process-session ownership for the subprocess seam. */

import { PassThrough } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { quoteShellArg } from './runtime.ts'
import type SshRuntime from './runtime.ts'
import { readRemoteEnvironment, scrubRemoteEnvironment, serializeEnvironment } from './environment.ts'

/** Normalize an SSH signal name into the `SIG…` vocabulary the seam carries. */
function normalizeSignal(signal: string | null): NodeJS.Signals | null {
  if (signal === null) return null
  return (signal.startsWith('SIG') ? signal : `SIG${signal}`) as NodeJS.Signals
}

/** Resolve after one duration. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** One SSH PTY and its remote login shell, projected onto the subprocess terminal seam. */
export class SshTerminalHandle implements SubprocessTerminalHandle {
  readonly pid = -1
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>

  private topLevelExited = false
  private cleanup: Promise<void> | undefined

  /**
   * @param channel - the allocated SSH shell channel.
   * @param graceMs - TERM-to-KILL and exit-wait grace.
   */
  constructor(
    private readonly channel: ClientChannel,
    private readonly graceMs: number,
  ) {
    this.done = this.waitForClose()
  }

  /** @inheritdoc */
  write(data: string): Promise<void> {
    if (this.topLevelExited) return Promise.reject(new Error('terminal process has exited'))
    return new Promise<void>((resolve, reject) => {
      this.channel.write(Buffer.from(data, 'utf8'), (error) => {
        if (error !== undefined) reject(error)
        else resolve()
      })
    })
  }

  /** The SSH channel does not expose a foreground process group. */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return Promise.resolve(undefined)
  }

  /** @inheritdoc */
  signalForeground(_signal: SubprocessTerminalSignal): Promise<number> {
    return Promise.reject(new Error('subprocess-ssh: cannot resolve the foreground process group over an SSH channel'))
  }

  /** @inheritdoc */
  terminate(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    const cleanup = this.closeOnce()
    this.cleanup = cleanup
    void cleanup.catch(() => { this.cleanup = undefined })
    return cleanup
  }

  private signal(name: string): void {
    try {
      this.channel.signal(name)
    } catch (_alreadyClosed) {
      // The channel closed before the signal could be delivered.
    }
  }

  private async waitForClose(): Promise<SubprocessOutcome> {
    try {
      return await new Promise<SubprocessOutcome>((resolve, reject) => {
        this.channel.on('data', (data: Buffer) => {
          if (!this.output.destroyed) this.output.write(data)
        })
        this.channel.on('close', (code: number | null, signal: string | null) => {
          this.topLevelExited = true
          this.output.end()
          resolve({ exitCode: code, signal: normalizeSignal(signal) })
        })
        this.channel.on('error', (error: Error) => {
          this.output.destroy(error)
          reject(error)
        })
      })
    } finally {
      this.topLevelExited = true
    }
  }

  private async closeOnce(): Promise<void> {
    this.signal('TERM')
    await Promise.race([this.done.then(() => undefined, () => undefined), delay(this.graceMs)])
    if (!this.topLevelExited) this.signal('KILL')
    await Promise.race([this.done.then(() => undefined, () => undefined), delay(this.graceMs)])
    if (!this.topLevelExited) throw new Error(`subprocess-ssh: terminal cleanup failed; channel still open`)
  }
}

/**
 * Allocate an SSH PTY, replace its login shell with the requested argv, and
 * return the live terminal handle.
 * @param ssh - shared SSH connection owner.
 * @param spec - fully specified terminal-process request.
 * @returns the live terminal handle after allocation succeeds.
 */
export async function spawnSshTerminal(ssh: SshRuntime, spec: SubprocessTerminalSpawnSpec): Promise<SshTerminalHandle> {
  spec.signal?.throwIfAborted()
  const program = spec.argv[0]
  if (program === undefined || program.length === 0) {
    throw new Error('subprocess-ssh: terminal argv must contain a program')
  }
  const remote = await readRemoteEnvironment(ssh)
  const environment = serializeEnvironment(scrubRemoteEnvironment(remote), spec.env)
  const client = await ssh.getClient()
  spec.signal?.throwIfAborted()
  const channel = await new Promise<ClientChannel>((resolve, reject) => {
    client.shell({ term: 'xterm-256color', rows: spec.rows, cols: spec.cols }, (error, stream) => {
      if (error !== undefined) reject(error)
      else resolve(stream)
    })
  })
  const handle = new SshTerminalHandle(channel, spec.graceMs)
  const argv = spec.argv.map(quoteShellArg).join(' ')
  await handle.write(`cd ${quoteShellArg(spec.cwd)} && exec env -i -- ${environment} ${argv}\r`)
  spec.signal?.throwIfAborted()
  return handle
}
