/**
 * dsh-ssh — SSH remote-execution plugin for DeepSeek Harness.
 *
 * Three Cordis plugins, one package. Mount them through the subpaths:
 * - `dsh-ssh/ssh` — shared SSH connection owner (`ctx.ssh`): ProxyJump chain, auth, keepalive, host-key verification.
 * - `dsh-ssh/subprocess` — remote subprocess provider (`ctx.subprocess`).
 * - `dsh-ssh/fs` — remote filesystem provider over SFTP (`ctx.fs`).
 * @module dsh-ssh
 */

export { SshRuntime, quoteShellArg, wrapCwd } from './runtime.ts'
export type { Config, JumpConfig, ExecOutcome } from './runtime.ts'
export { SshSubprocessRuntime } from './subprocess.ts'
export { SshFileSystem } from './filesystem.ts'
