/**
 * Execution-world transport shared by the SSH subprocess and filesystem
 * providers. The aggregate `ctx.ssh` service is the default transport; an
 * `ssh://<connectionId>/<path>` working directory routes one operation to a
 * registry-owned connection instead, so sessions created from the web
 * connection manager execute on the host they were opened against.
 * @module dsh-ssh/transport
 */

import type { Client, SFTPWrapper } from 'ssh2'
import type { Context } from '@deepseek-ai/cordis'
import type { ExecOutcome, SshRuntime } from './runtime.ts'
import type { SshRegistry } from './registry.ts'
import { parseSshRoute } from './registry.ts'

/** The connection-owner face both providers consume. */
export interface SshTransport {
  /** Human-readable connection target for UI surfaces (`username@host`). */
  readonly endpoint: string
  /** The transport's default remote working directory. */
  readonly cwd: string
  /** The authenticated target client after the jump chain succeeds. */
  getClient(signal?: AbortSignal): Promise<Client>
  /** The shared SFTP channel, opened lazily once per connection. */
  getSftp(signal?: AbortSignal): Promise<SFTPWrapper>
  /** The remote login environment, read once and cached. */
  getRemoteEnvironment(signal?: AbortSignal): Promise<Record<string, string>>
  /** Run one control-plane command with collected output. */
  exec(command: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<ExecOutcome>
  /** Map a caller-supplied working directory onto the transport's remote host. */
  resolveRemoteCwd(cwd: string | undefined): string
}

/** A working directory resolved against one concrete transport. */
export interface SshCwdRoute {
  /** The transport owning the resolved remote directory. */
  transport: SshTransport
  /** The absolute POSIX directory to execute in. */
  cwd: string
  /** Registry connection id when the caller supplied an `ssh://` route. */
  connectionId?: string
}

/** Build the opaque target key used by the filesystem backend for one route. */
export function sshTargetKey(connectionId: string, path: string): string {
  return `ssh://${connectionId}${path}`
}

/** Split a filesystem target key into its transport route and remote path. */
export function parseSshTargetKey(targetKey: string): { connectionId?: string; path: string } {
  const route = parseSshRoute(targetKey)
  if (route !== null) return { connectionId: route.id, path: route.path }
  return { path: targetKey }
}

/**
 * Resolve one caller cwd against the transport it names. POSIX absolute paths
 * and the normal local-path redirection stay on the aggregate `ctx.ssh`;
 * `ssh://<id>/<path>` selects the live registry connection for that id.
 */
export function resolveSshCwd(ctx: Context, cwd: string | undefined): SshCwdRoute {
  if (cwd !== undefined && cwd.startsWith('ssh://')) {
    const route = parseSshRoute(cwd)
    if (route === null) throw new Error(`dsh-ssh: invalid remote working directory ${JSON.stringify(cwd)}`)
    const registry = ctx.get('sshRegistry') as SshRegistry | undefined
    const connection = registry?.get(route.id)
    if (connection === undefined) {
      throw new Error(`dsh-ssh: remote working directory names unknown connection "${route.id}" (is dsh-ssh/web mounted?)`)
    }
    return { transport: connection, cwd: route.path, connectionId: route.id }
  }
  return { transport: ctx.ssh as unknown as SshTransport, cwd: (ctx.ssh as SshRuntime).resolveRemoteCwd(cwd) }
}

/** Resolve an encoded filesystem target key against its owning transport. */
export function resolveSshTargetKey(ctx: Context, targetKey: string): SshCwdRoute & { path: string } {
  const parsed = parseSshTargetKey(targetKey)
  if (parsed.connectionId === undefined) {
    return { transport: ctx.ssh as unknown as SshTransport, cwd: (ctx.ssh as SshRuntime).resolveRemoteCwd(parsed.path), path: parsed.path }
  }
  const registry = ctx.get('sshRegistry') as SshRegistry | undefined
  const connection = registry?.get(parsed.connectionId)
  if (connection === undefined) {
    throw new Error(`dsh-ssh: target names unknown connection "${parsed.connectionId}" (is dsh-ssh/web mounted?)`)
  }
  return { transport: connection, cwd: parsed.path, connectionId: parsed.connectionId, path: parsed.path }
}
