/**
 * Browser half of dsh-ssh: the add-workspace directory flow — a connection
 * sidebar (saved connections, `~/.ssh/config` hosts, local entry) beside the
 * directory browser. Registered into both directory-flow holes, so mounting
 * `dsh-ssh` composes the whole picking interaction. Cross-plane calls ride the
 * shared web transport: local listing through the `workspaces` service (the
 * Host's `directoryPicker` browse capability) and remote listing/connection
 * management through the package's `/dsh-ssh` RPC channel.
 */

import type { Context } from '@deepseek-ai/cordis'
import { SshWorkspaceFlow } from './flow.tsx'

/** Local, self-contained wire contracts (no cross-plugin value imports). */
export interface WireEntry {
  name: string
  path: string
  hidden: boolean
}

export interface WireListing {
  path: string
  home: string
  crumbs: WireEntry[]
  entries: WireEntry[]
  truncated: boolean
}

export interface ConnectionView {
  id: string
  label: string
  host: string
  port: number
  username: string
  cwd?: string
  auth: 'password' | 'key' | 'agent'
  jumpHosts: string[]
}

/** One exact `~/.ssh/config` Host alias (the `config.hosts` wire row). */
export interface ConfigHostView {
  alias: string
  host: string
  username: string
  port: number
  identityFile: boolean
  jump: boolean
}

export type WireResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }

/** The client workspace service's directory faces. */
export interface ClientWorkspaces {
  listDirectory(path?: string, signal?: AbortSignal): Promise<WireListing>
  createDirectory(path: string, name: string): Promise<string>
}

/** The client sessions service's remote-open face. */
export interface ClientSessions {
  create(opts: { workspaceId?: string; cwd?: string; sessionId?: string }): Promise<string>
  open(sessionId: string): void
}

/** The client connection handle's RPC face. */
export interface ClientConnection {
  rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<WireResult>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: {
      inject(key: string, callback: () => (() => void) | Iterable<() => void, void, void>): () => void
      register(options: { name: string; inject?: (...args: never[]) => Record<string, unknown> }, component: unknown): () => void
    }
    workspaces: ClientWorkspaces
    // NOTE: `sessions` is deliberately NOT redeclared here. The installed
    // node-side `@deepseek-ai/dsh-session` already augments Context with
    // `sessions: SessionStore`; the browser bundle's sessions service has the
    // client face below, so apply() narrows through a local cast instead of
    // a second, conflicting augmentation.
  }
}

/** Required client services: the slot registry and the wire-facing workspace service. */
export const inject = ['slots', 'workspaces', 'sessions']

/**
 * Client plugin body: fill both directory-flow holes with the SSH workspace
 * flow. `slots.inject` waits for each hole's declaration, and the generator
 * installs the two registrations transactionally.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  // The browser bundle's sessions service (client face of the node SessionStore).
  const sessions = ctx.sessions as unknown as ClientSessions
  const injected = (): Record<string, unknown> => ({
    listLocalDirectory: (path?: string, signal?: AbortSignal) => ctx.workspaces.listDirectory(path, signal),
    createLocalDirectory: (path: string, name: string) => ctx.workspaces.createDirectory(path, name),
      openRemoteSession: async (cwd: string) => {
        const sessionId = await sessions.create({ cwd })
        sessions.open(sessionId)
      },
    rpc: (endpoint: string, payload?: unknown, signal?: AbortSignal) => {
      const connection = ctx.get('connection') as ClientConnection | undefined
      if (connection === undefined) {
        return Promise.resolve({ ok: false, error: { code: 'internal', message: 'dsh-ssh: the web transport is not available' } } as WireResult)
      }
      return connection.rpc.call('/dsh-ssh', endpoint, payload ?? {}, signal)
    },
  })
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({
        name: 'conversation.hero.workspace.directoryFlow', inject: injected,
      }, SshWorkspaceFlow)
      yield ctx.slots.register({
        name: 'sidebar.workspaces.directoryFlow', inject: injected,
      }, SshWorkspaceFlow)
    }))
}
