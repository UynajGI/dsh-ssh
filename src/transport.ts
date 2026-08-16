/**
 * Execution-world transport shared by the SSH subprocess and filesystem
 * providers. The aggregate `ctx.ssh` service is the default transport; an
 * `ssh://<connectionId>/<path>` working directory routes one operation to a
 * registry-owned connection instead, so sessions created from the web
 * connection manager execute on the host they were opened against.
 *
 * The web client cannot pass an `ssh://` cwd to `sessions.create` — the host's
 * session service unconditionally `mkdir`s the project directory through
 * `node:fs`. So each remote route also has a LOCAL placeholder directory
 * (`<dsh home>/dsh-ssh-routes/<id>/<remote path>`) that the client registers
 * and hands to `sessions.create`; both spellings route to the same registry
 * connection here.
 * @module dsh-ssh/transport
 */

import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
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
  const placeholder = routeFromPlaceholder(targetKey)
  if (placeholder !== null) return { connectionId: placeholder.id, path: placeholder.path }
  return { path: targetKey }
}

/** Root of the local placeholder tree standing in for remote routes. */
export function sshRoutesRoot(): string {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-ssh-routes')
}

/** The local placeholder path of one registry route (created by `session.route`). */
export function sshRoutePlaceholder(connectionId: string, remotePath: string): string {
  const segments = remotePath.split('/').filter(segment => segment !== '')
  return join(sshRoutesRoot(), connectionId, ...segments)
}

/**
 * Recover the registry route a local placeholder names
 * (`<root>/<id>/<remote path…>` → connection id + absolute POSIX path).
 */
function routeFromPlaceholder(value: string): { id: string; path: string } | null {
  if (!value.toLowerCase().includes('dsh-ssh-routes')) return null
  const rel = relative(sshRoutesRoot(), resolve(value))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  const segments = rel.split(/[\\/]+/).filter(segment => segment !== '')
  const id = segments[0]
  if (id === undefined || !/^[A-Za-z0-9._-]+$/.test(id)) return null
  const rest = segments.slice(1)
  return { id, path: rest.length === 0 ? '/' : `/${rest.join('/')}` }
}

/**
 * Resolve one caller cwd against the transport it names. POSIX absolute paths
 * and the normal local-path redirection stay on the aggregate `ctx.ssh`;
 * `ssh://<id>/<path>` and its local placeholder both select the live registry
 * connection for that id.
 */
export function resolveSshCwd(ctx: Context, cwd: string | undefined): SshCwdRoute {
  if (cwd !== undefined) {
    const parsed = cwd.startsWith('ssh://') ? parseSshRoute(cwd) : routeFromPlaceholder(cwd)
    if (parsed === null && cwd.startsWith('ssh://')) {
      throw new Error(`dsh-ssh: invalid remote working directory ${JSON.stringify(cwd)}`)
    }
    if (parsed !== null) {
      const registry = ctx.get('sshRegistry') as SshRegistry | undefined
      const connection = registry?.get(parsed.id)
      if (connection === undefined) {
        throw new Error(`dsh-ssh: remote working directory names unknown connection "${parsed.id}" (is dsh-ssh/web mounted?)`)
      }
      return { transport: connection, cwd: parsed.path, connectionId: parsed.id }
    }
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
