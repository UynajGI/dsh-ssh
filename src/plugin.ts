/**
 * One-row aggregate plugin: mounts the shared SSH connection owner plus the
 * remote subprocess and filesystem providers. `name: dsh-ssh` in cordis.yml
 * is equivalent to the three subpath rows (`dsh-ssh/ssh`, `dsh-ssh/subprocess`,
 * `dsh-ssh/fs`) and needs no `inject` — the subprocess and filesystem
 * providers resolve `ssh` through the same context.
 * @module dsh-ssh/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import SshRuntime from './runtime.ts'
import type { Config } from './runtime.ts'
import SshSubprocessRuntime from './subprocess.ts'
import SshFileSystem from './filesystem.ts'

/**
 * Mount the aggregate plugin.
 * @param ctx - the mounting Cordis context.
 * @param config - the shared SSH connection configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(SshRuntime, config)
  ctx.plugin(SshSubprocessRuntime)
  ctx.plugin(SshFileSystem)
}
