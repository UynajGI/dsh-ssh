/** One asynchronously-started SSH command projected onto the subprocess seam. */

import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'
import type { Readable, Writable } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { quoteShellArg } from './runtime.ts'
import type SshRuntime from './runtime.ts'
import { readRemoteEnvironment, scrubRemoteEnvironment, serializeEnvironment } from './environment.ts'
import { SshOutputCollector } from './output.ts'

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return mode !== 'pipe' && mode !== 'inherit'
}

/** Normalize an SSH signal name into the `SIG…` vocabulary the seam carries. */
function normalizeSignal(signal: string | null | undefined): NodeJS.Signals | null {
  if (signal === null || signal === undefined) return null
  return (signal.startsWith('SIG') ? signal : `SIG${signal}`) as NodeJS.Signals
}

/**
 * Build the remote command text: change to the working directory, then replace
 * the environment with the scrubbed remote base plus explicit entries and exec
 * the argv. `env -i` prevents credential-shaped remote names from leaking into
 * the child; the scrubbed base restores PATH and HOME.
 * @param ssh - shared SSH connection owner.
 * @param spec - fully resolved subprocess request.
 * @returns the remote command text.
 */
async function buildCommand(ssh: SshRuntime, spec: SubprocessSpawnSpec): Promise<string> {
  const remote = await readRemoteEnvironment(ssh)
  const environment = serializeEnvironment(scrubRemoteEnvironment(remote), spec.env)
  const argv = spec.argv.map(quoteShellArg).join(' ')
  return `cd -- ${quoteShellArg(ssh.resolveRemoteCwd(spec.cwd))} && exec env -i -- ${environment} ${argv}`
}

/** SSH-backed subprocess handle. The channel does not expose a remote pid, so `pid` is `-1`. */
export class SshSubprocessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>

  private readonly terminationController = new AbortController()
  private readonly stdoutCollector: SshOutputCollector | undefined
  private readonly stderrCollector: SshOutputCollector | undefined
  private channel: ClientChannel | undefined
  private graceTimer: NodeJS.Timeout | undefined
  private settled = false

  /**
   * Start the SSH command without blocking the synchronous spawn call.
   * @param runtime - shared SSH connection owner.
   * @param spec - fully resolved subprocess request.
   * @param spillDir - local spill directory for collect-mode streams.
   */
  constructor(
    private readonly runtime: SshRuntime,
    private readonly spec: SubprocessSpawnSpec,
    private readonly spillDir: string,
  ) {
    const outMode = spec.stdio.stdout
    const errMode = spec.stdio.stderr
    this.stdout = outMode === 'pipe' ? new PassThrough() : undefined
    this.stderr = errMode === 'pipe' ? new PassThrough() : undefined
    this.stdoutCollector = isCollect(outMode)
      ? new SshOutputCollector(outMode.maxBytes, outMode.spill?.maxBytes, 'stdout', spillDir)
      : undefined
    this.stderrCollector = isCollect(errMode)
      ? new SshOutputCollector(errMode.maxBytes, errMode.spill?.maxBytes, 'stderr', spillDir)
      : undefined
    this.collected = {
      ...(this.stdoutCollector !== undefined ? { stdout: this.stdoutCollector } : {}),
      ...(this.stderrCollector !== undefined ? { stderr: this.stderrCollector } : {}),
    }
    this.stdin = spec.stdio.stdin === 'pipe' ? new PassThrough() : undefined

    spec.signal?.addEventListener('abort', this.onAbort, { once: true })
    this.done = this.run()
    void this.done.catch(() => {})
    if (spec.signal?.aborted === true) this.terminate()
  }

  /** Remote process id; `-1` because the SSH channel does not expose one. */
  get pid(): number {
    return -1
  }

  /** @inheritdoc */
  terminate(): void {
    if (this.settled || this.terminationController.signal.aborted) return
    this.terminationController.abort(new Error('subprocess-ssh: command terminated'))
    const channel = this.channel
    if (channel !== undefined) this.signalTerm(channel)
  }

  /** @inheritdoc */
  waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.settled) return Promise.resolve(true)
    if (signal?.aborted === true) return Promise.resolve(false)
    if (signal === undefined) {
      return this.done.then(() => true, () => true)
    }
    return new Promise<boolean>((resolve) => {
      const onAbort = (): void => { cleanup(); resolve(false) }
      const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
      signal.addEventListener('abort', onAbort, { once: true })
      void this.done.then(() => { cleanup(); resolve(true) }, () => { cleanup(); resolve(true) })
    })
  }

  private readonly onAbort = (): void => { this.terminate() }

  private signalTerm(channel: ClientChannel): void {
    try {
      channel.signal('TERM')
    } catch (_alreadyClosed) {
      // The channel closed before the signal could be delivered; close is authoritative.
    }
    this.graceTimer = setTimeout(() => {
      try {
        channel.signal('KILL')
      } catch (_alreadyClosedAfterGrace) {
        // Escalation after a graceful close is a no-op.
      }
    }, this.spec.graceMs)
  }

  private settle(): void {
    if (this.settled) return
    this.settled = true
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer)
    this.graceTimer = undefined
    this.stdoutCollector?.seal()
    this.stderrCollector?.seal()
    this.spec.signal?.removeEventListener('abort', this.onAbort)
  }

  private async run(): Promise<SubprocessOutcome> {
    let channel: ClientChannel
    try {
      const command = await buildCommand(this.runtime, this.spec)
      const client = await this.runtime.getClient()
      channel = await new Promise<ClientChannel>((resolve, reject) => {
        client.exec(command, { pty: false }, (error, stream) => {
          if (error !== undefined) reject(error)
          else resolve(stream)
        })
      })
    } catch (error) {
      this.settle()
      throw error
    }
    this.channel = channel
    if (this.terminationController.signal.aborted) this.signalTerm(channel)

    this.wireStdout(channel)
    this.wireStderr(channel)
    if (this.stdin !== undefined) {
      this.stdin.pipe(channel)
    } else if (typeof this.spec.stdio.stdin === 'object') {
      channel.end(this.spec.stdio.stdin.data)
    }

    return await new Promise<SubprocessOutcome>((resolve, reject) => {
      channel.on('close', (code: number | null, signal: string | null) => {
        this.settle()
        resolve({ exitCode: code, signal: normalizeSignal(signal) })
      })
      channel.on('error', (error: Error) => {
        this.settle()
        reject(error)
      })
    })
  }

  private wireStdout(channel: ClientChannel): void {
    const mode = this.spec.stdio.stdout
    if (mode === 'pipe') channel.pipe(this.stdout as PassThrough)
    else if (mode === 'inherit') channel.pipe(process.stdout)
    else channel.on('data', (data: Buffer) => { this.stdoutCollector?.push(data) })
  }

  private wireStderr(channel: ClientChannel): void {
    const mode = this.spec.stdio.stderr
    if (mode === 'pipe') channel.stderr.pipe(this.stderr as PassThrough)
    else if (mode === 'inherit') channel.stderr.pipe(process.stderr)
    else channel.stderr.on('data', (data: Buffer) => { this.stderrCollector?.push(data) })
  }
}
