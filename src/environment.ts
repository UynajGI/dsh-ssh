/** Shared remote-environment scrubbing for the SSH process and terminal launchers. */

import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import { quoteShellArg } from './runtime.ts'
import type { SshTransport } from './transport.ts'

/**
 * Read the remote login environment, cached on the shared connection owner.
 * @param ssh - connection owner backing this execution world.
 * @returns the remote environment as name/value entries.
 */
export async function readRemoteEnvironment(ssh: SshTransport): Promise<Record<string, string>> {
  return ssh.getRemoteEnvironment()
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
