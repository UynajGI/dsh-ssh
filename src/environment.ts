/** Shared remote-environment scrubbing for the SSH process and terminal launchers. */

import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import { quoteShellArg } from './runtime.ts'
import type SshRuntime from './runtime.ts'

/**
 * Read the remote login environment through a NUL-delimited `env -0`.
 * @param ssh - shared SSH connection owner.
 * @returns the remote environment as name/value entries.
 */
export async function readRemoteEnvironment(ssh: SshRuntime): Promise<Record<string, string>> {
  const { exitCode, stdout } = await ssh.exec('env -0')
  if (exitCode !== 0) throw new Error('subprocess-ssh: cannot read the remote environment')
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
 * Remove harness-private and credential-shaped names from a remote environment.
 * @param environment - the remote environment to scrub.
 * @returns retained entries for the caller to overlay and serialize.
 */
export function scrubRemoteEnvironment(environment: Readonly<Record<string, string>>): Map<string, string> {
  const scrubbed = new Map<string, string>()
  for (const [name, value] of Object.entries(environment)) {
    if (name.startsWith('DSH_') || SENSITIVE_ENV_PATTERN.test(name)) continue
    scrubbed.set(name, value)
  }
  return scrubbed
}

/**
 * Overlay explicit entries and serialize one validated environment for `env -i`.
 * @param scrubbed - the scrubbed remote base.
 * @param explicit - deliberate caller overrides; an `undefined` tombstone removes an ambient entry.
 * @returns shell-quoted `name=value` words accepted by `env -i --`.
 */
export function serializeEnvironment(
  scrubbed: ReadonlyMap<string, string>,
  explicit: Readonly<NodeJS.ProcessEnv> | undefined,
): string {
  const environment = new Map(scrubbed)
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (name.length === 0 || name.includes('=') || name.includes('\0') || value?.includes('\0') === true) {
      throw new Error('subprocess-ssh: environment entries require non-empty NUL-free names without = and NUL-free values')
    }
    if (value === undefined) environment.delete(name)
    else environment.set(name, value)
  }
  return [...environment].map(([name, value]) => quoteShellArg(`${name}=${value}`)).join(' ')
}
