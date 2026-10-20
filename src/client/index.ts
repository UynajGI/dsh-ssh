/**
 * Browser half of dsh-ssh: the add-workspace directory flow — a connection
 * sidebar (saved connections, `~/.ssh/config` hosts, local entry) beside the
 * directory browser. Registered into both directory-flow holes, so mounting
 * `dsh-ssh` composes the whole picking interaction. Cross-plane calls ride the
 * shared web transport: local listing through the client's workspace directory
 * service (`ctx.uiWorkspace` on DSH ≥ 0.2.0-rc.2, `ctx.workspaces` before that)
 * and remote listing/connection management through the package's `/dsh-ssh` RPC
 * channel.
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

/** Transport recovery lifecycle exposed by DSH ≥ 0.2.x. */
export type ConnectionState = 'connected' | 'connecting' | 'disconnected'

/** Observable recovery state of the shared client transport. */
export interface ConnectionStateSource {
  getSnapshot(): ConnectionState | undefined
  subscribe(listener: () => void): () => void
}

/** The client connection handle's RPC face. */
export interface ClientConnection {
  rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<WireResult>
  }
  /** Recovery lifecycle; older clients expose only `rpc`. */
  state?: ConnectionStateSource
  /** Reset retry progression and replace the current attempt immediately. */
  reconnect?(): void
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A fresh connection generation was established; wire-derived caches must repull. */
    'connection/reset'(): void
  }
  interface Context {
    slots: {
      inject(key: string, callback: () => (() => void) | Iterable<() => void, void, void>): () => void
      register(options: { name: string; inject?: (...args: never[]) => Record<string, unknown> }, component: unknown): () => void
    }
    /** Client directory-picker bridge on DSH ≥ 0.2.0-rc.2. */
    uiWorkspace?: ClientWorkspaces
    /**
     * Older DSH builds exposed the same directory faces on `workspaces`. DSH
     * 0.2.0-rc.2 reuses that key for its workspace-controller face, so the
     * capability is probed per call rather than trusted by name.
     */
    workspaces?: Partial<ClientWorkspaces>
  }
}

/**
 * Required client service: the slot registry. The workspace directory service is
 * resolved lazily because its key moved (`workspaces` → `uiWorkspace` in DSH
 * 0.2.0-rc.2), and because the current `workspaces` key is a different service.
 */
export const inject = ['slots']

/**
 * The client service owning the directory-picker bridge
 * (`listDirectory`/`createDirectory`).
 * @param ctx - client root context.
 * @returns the first registered service exposing both directory faces.
 * @throws when no composed client service carries them.
 */
function directoryService(ctx: Context): ClientWorkspaces {
  for (const name of ['uiWorkspace', 'workspaces'] as const) {
    const service = ctx.get(name)
    if (typeof service?.listDirectory === 'function' && typeof service.createDirectory === 'function') {
      return service as ClientWorkspaces
    }
  }
  throw new Error('dsh-ssh: no client workspace directory service is available (expected ctx.uiWorkspace)')
}

/**
 * Client plugin body: fill both directory-flow holes with the SSH workspace
 * flow. `slots.inject` waits for each hole's declaration, and the generator
 * installs the two registrations transactionally.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const injected = (): Record<string, unknown> => {
    const connection = ctx.get('connection') as ClientConnection | undefined
    return {
      listLocalDirectory: (path?: string, signal?: AbortSignal) => directoryService(ctx).listDirectory(path, signal),
      createLocalDirectory: (path: string, name: string) => directoryService(ctx).createDirectory(path, name),
      connection,
      subscribeConnectionReset: (listener: () => void) => ctx.on('connection/reset', listener),
      rpc: (endpoint: string, payload?: unknown, signal?: AbortSignal) => {
        const live = ctx.get('connection') as ClientConnection | undefined
        if (live === undefined) {
          return Promise.resolve({ ok: false, error: { code: 'internal', message: 'dsh-ssh: the web transport is not available' } } as WireResult)
        }
        return live.rpc.call('/dsh-ssh', endpoint, payload ?? {}, signal)
      },
    }
  }
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
