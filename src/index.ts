/**
 * dsh-ssh — SSH remote-execution plugin for DeepSeek Harness.
 *
 * One package, two mounting styles:
 * - `name: dsh-ssh` — aggregate plugin: mounts the shared connection owner
 *   (`ctx.ssh`) plus the remote subprocess (`ctx.subprocess`) and filesystem
 *   (`ctx.fs`) providers in one row.
 * - Subpath rows (`dsh-ssh/ssh`, `dsh-ssh/subprocess`, `dsh-ssh/fs`) mount
 *   each service separately, for deployments that compose providers
 *   individually.
 * @module dsh-ssh
 */

export { SshRuntime, quoteShellArg, wrapCwd } from './runtime.ts'
export type { Config, JumpConfig, ExecOutcome } from './runtime.ts'
export { SshSubprocessRuntime } from './subprocess.ts'
export { SshFileSystem } from './filesystem.ts'
export { apply } from './plugin.ts'
