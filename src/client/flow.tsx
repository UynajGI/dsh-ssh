/**
 * The add-workspace directory flow of dsh-ssh, laid out as a connection
 * sidebar beside a directory browser (VS Code Remote Explorer style): the
 * sidebar lists `~/.ssh/config` hosts (one click resolves, registers, and
 * browses — no form), saved connections, and the local entry; the right pane
 * browses whichever side is active. Picking a remote directory hands the owner
 * an `ssh://<id><path>` workspace path, which the deployment's remote
 * providers consume (see README for the workspace-adoption seam).
 */

import { useEffect, useRef, useState } from 'react'
import type { ConfigHostView, ConnectionView, WireEntry, WireListing, WireResult } from './index.ts'
import { ConnectionForm } from './form.tsx'
import type { ConnectionDraft, ConnectionInputWire, ResolvedSshConfigView } from './form.tsx'
import { cx, useDialogA11y } from './ui.ts'
import {
  AlertIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  EyeIcon,
  FolderIcon,
  FolderPlusIcon,
  HomeIcon,
  KeyIcon,
  LockIcon,
  MonitorIcon,
  PlusIcon,
  RefreshIcon,
  RouteIcon,
  ServerIcon,
  SpinnerIcon,
  TrashIcon,
} from './icons.tsx'
import styles from './flow.module.css'

/** Services the plugin injects into every registration. */
export interface FlowInjected {
  listLocalDirectory(path?: string, signal?: AbortSignal): Promise<WireListing>
  createLocalDirectory(path: string, name: string): Promise<string>
  rpc(endpoint: string, payload?: unknown, signal?: AbortSignal): Promise<WireResult>
}

/** The owner share of the directory-flow holes (see ui-workspace's contract). */
export interface FlowProps {
  open: boolean
  busy: boolean
  onPicked(path: string): void
  onCancel(): void
  onError(message: string): void
}

/** Which filesystem the browser pane is showing. */
type Mode = { kind: 'local' } | { kind: 'remote'; id: string }

/** One listing pane's live state. */
interface Pane {
  path: string | null
  listing: WireListing | null
  error: string | null
  loading: boolean
}

const EMPTY_PANE: Pane = { path: null, listing: null, error: null, loading: false }

/** A remote failure translated for the right pane (auth ones can route to the form). */
interface RemoteFailure {
  title: string
  text: string
  needsAuth: boolean
}

/** Unwrap a wire result or throw its business error. */
function unwrap<T>(result: WireResult, fallback: string): T {
  if (!result.ok) throw new Error(result.error.message || fallback)
  return result.value as T
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Minimal structural check for a wire listing. */
function asListing(value: unknown): WireListing {
  const record = isRecord(value) ? value : {}
  const wireEntry = (entry: unknown): WireEntry => ({
    name: String((entry as Record<string, unknown> | undefined)?.name ?? ''),
    path: String((entry as Record<string, unknown> | undefined)?.path ?? ''),
    hidden: (entry as Record<string, unknown> | undefined)?.hidden === true,
  })
  return {
    path: typeof record.path === 'string' ? record.path : '',
    home: typeof record.home === 'string' ? record.home : '',
    crumbs: Array.isArray(record.crumbs) ? record.crumbs.filter(isRecord).map(wireEntry) : [],
    entries: Array.isArray(record.entries) ? record.entries.filter(isRecord).map(wireEntry) : [],
    truncated: record.truncated === true,
  }
}

/** Structural check for one `config.hosts` row. */
function asConfigHosts(value: unknown): ConfigHostView[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map(record => ({
    alias: String(record.alias ?? ''),
    host: String(record.host ?? ''),
    username: String(record.username ?? ''),
    port: typeof record.port === 'number' ? record.port : 22,
    identityFile: record.identityFile === true,
    jump: record.jump === true,
  })).filter(host => host.alias !== '')
}

/** Structural check for one secret-free connection view. */
function asConnectionView(record: Record<string, unknown>): ConnectionView {
  return {
    id: String(record.id ?? ''),
    label: String(record.label ?? ''),
    host: String(record.host ?? ''),
    port: typeof record.port === 'number' ? record.port : 22,
    username: String(record.username ?? ''),
    ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
    auth: (record.auth === 'password' || record.auth === 'agent' ? record.auth : 'key') as ConnectionView['auth'],
    jumpHosts: Array.isArray(record.jumpHosts) ? record.jumpHosts.map(String) : [],
  }
}

/** Structural check for a `connections.resolve` result. */
function asResolved(value: unknown): ResolvedSshConfigView {
  const record = isRecord(value) ? value : {}
  return {
    host: typeof record.host === 'string' ? record.host : '',
    username: typeof record.username === 'string' ? record.username : '',
    port: typeof record.port === 'number' ? record.port : 22,
    privateKeyPaths: Array.isArray(record.privateKeyPaths) ? record.privateKeyPaths.map(String) : [],
    jump: Array.isArray(record.jump) ? record.jump.filter(isRecord).map(hop => ({
      host: String(hop.host ?? ''),
      ...(typeof hop.port === 'number' ? { port: hop.port } : {}),
      ...(typeof hop.username === 'string' && hop.username !== '' ? { username: hop.username } : {}),
      ...(hop.privateKeyPath !== undefined ? { privateKeyPath: String(hop.privateKeyPath) } : {}),
    })) : [],
    alias: typeof record.alias === 'string' ? record.alias : '',
  }
}

/** Structural check for a `connections.add` result (its view only). */
function asAddedView(value: unknown): ConnectionView {
  const record = isRecord(value) ? value : {}
  return asConnectionView(isRecord(record.view) ? record.view : {})
}

/**
 * Translate a raw ssh2/web error into a readable remote failure. ssh2 never
 * consults the OS agent or default identities on its own, so a spec without
 * password/privateKey/agent surfaces as `All configured authentication
 * methods failed` — that one gets the auth-completion guidance.
 */
function describeRemoteFailure(raw: string): RemoteFailure {
  if (/invalid_union/.test(raw)) {
    return {
      title: '无法创建远程会话',
      text: '宿主返回了无法解析的错误响应——最常见的原因是 SSH 连接失败。请检查该主机的认证与网络配置后重试。',
      needsAuth: false,
    }
  }
  if (/all configured authentication methods/i.test(raw)) {
    return {
      title: '认证失败',
      text: '该主机没有可用的私钥或密码，SSH 服务器拒绝了登录。可点击「补全认证」，在表单中填写认证信息后重试。',
      needsAuth: true,
    }
  }
  if (/cannot parse privatekey|cannot read private key|invalid private key|no key found/i.test(raw)) {
    return {
      title: '私钥不可用',
      text: `无法读取或解析私钥文件，请检查路径、口令与文件权限。原始错误：${raw}`,
      needsAuth: true,
    }
  }
  if (/timed?\s?out|etimedout/i.test(raw)) {
    return { title: '连接超时', text: '在超时前未能建立连接，请检查主机名、端口与网络可达性。', needsAuth: false }
  }
  if (/econnrefused/i.test(raw)) {
    return { title: '连接被拒绝', text: '目标端口未开放或拒绝了连接，请核对端口。', needsAuth: false }
  }
  if (/enotfound|getaddrinfo|dns/i.test(raw)) {
    return { title: '找不到主机', text: '域名解析失败，请核对主机名或修正 ~/.ssh/config 中的 HostName。', needsAuth: false }
  }
  if (/ehostunreach|enetunreach/i.test(raw)) {
    return { title: '网络不可达', text: '本机无法路由到该主机，请检查网络或跳板配置。', needsAuth: false }
  }
  return { title: '无法连接远程主机', text: raw, needsAuth: false }
}

/** The directory-flow occupant registered into both workspace holes. */
export function SshWorkspaceFlow(props: FlowProps & FlowInjected) {
  const { open, busy, onPicked, onCancel, listLocalDirectory, createLocalDirectory, rpc } = props

  const [mode, setMode] = useState<Mode>({ kind: 'local' })
  const [pane, setPane] = useState<Pane>(EMPTY_PANE)
  const [connections, setConnections] = useState<ConnectionView[]>([])
  const [connectionsLoading, setConnectionsLoading] = useState(false)
  const [connectionsError, setConnectionsError] = useState<string | null>(null)
  const [configHosts, setConfigHosts] = useState<ConfigHostView[]>([])
  const [configLoading, setConfigLoading] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  const [hostPending, setHostPending] = useState<string | null>(null)
  const [hostError, setHostError] = useState<{ alias: string; message: string } | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<{ host: ConfigHostView; resolved: ResolvedSshConfigView } | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [formDraft, setFormDraft] = useState<ConnectionDraft | undefined>(undefined)
  const [folderDraft, setFolderDraft] = useState<string | null>(null)
  const [openingRemote, setOpeningRemote] = useState(false)
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [nativePicking, setNativePicking] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ConnectionView | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const generation = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)
  const configGeneration = useRef(0)
  const configRequest = useRef<AbortController | null>(null)
  const modeRef = useRef<Mode>(mode)
  modeRef.current = mode
  const paneRef = useRef<Pane>(pane)
  paneRef.current = pane

  const dialogRef = useDialogA11y(open, () => { onCancel() })
  const folderDialogRef = useDialogA11y(folderDraft !== null, () => { if (!folderBusy) setFolderDraft(null) })
  const deleteDialogRef = useDialogA11y(deleteTarget !== null, () => { if (removingId === null) setDeleteTarget(null) })
  const confirmDialogRef = useDialogA11y(confirmTarget !== null, () => { if (hostPending === null) setConfirmTarget(null) })

  /** List one level, guarding against superseded/closed generations. */
  const loadLevel = async (request: (signal: AbortSignal) => Promise<WireListing>): Promise<void> => {
    const current = generation.current += 1
    const controller = new AbortController()
    activeRequest.current = controller
    setPane(previous => ({ ...previous, loading: true, error: null }))
    try {
      const listing = await request(controller.signal)
      if (current !== generation.current || controller.signal.aborted) return
      setPane({ path: listing.path, listing, error: null, loading: false })
    } catch (error) {
      if (current !== generation.current || controller.signal.aborted) return
      setPane(previous => ({ ...previous, loading: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const navigateLocal = (path?: string): void => {
    setMode({ kind: 'local' })
    void loadLevel(signal => listLocalDirectory(path, signal))
  }

  const navigateRemote = (id: string, path?: string): void => {
    setMode({ kind: 'remote', id })
    void loadLevel(async signal => asListing(unwrap(await rpc('browse.list', { id, ...(path !== undefined ? { path } : {}) }, signal), 'browse.list failed')))
  }

  const openRemotePath = async (): Promise<void> => {
    if (mode.kind !== 'remote' || pane.path === null || openingRemote) return
    setOpeningRemote(true)
    try {
      // The host mkdir's the session cwd locally, so hand it the local
      // placeholder that stands in for the remote route (both spellings
      // resolve to the same registry connection in the providers). Adopt it
      // through the host's own pick flow: the session gets a workspaceId
      // (the web hero gates cwd-only sessions), and the placeholder routes
      // every bash/fs/terminal operation onto the remote host.
      const routed = unwrap(await rpc('session.route', { id: mode.id, path: pane.path }), 'session.route failed')
      const cwd = isRecord(routed) && typeof routed.cwd === 'string' ? routed.cwd : ''
      if (cwd === '') throw new Error('session.route 未返回会话目录')
      onPicked(cwd)
    } catch (error) {
      setPane(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setOpeningRemote(false)
    }
  }

  /**
   * Refresh the connection list. `silent` keeps the previous list on screen
   * (post-mutation refreshes) instead of flashing the skeleton.
   */
  const refreshConnections = async (silent = false): Promise<void> => {
    if (!silent) setConnectionsLoading(true)
    try {
      const value = unwrap(await rpc('connections.list'), 'connections.list failed')
      if (Array.isArray(value)) {
        setConnections(value.filter(isRecord).map(asConnectionView))
        setConnectionsError(null)
      }
    } catch (error) {
      setConnectionsError(error instanceof Error ? error.message : String(error))
    } finally {
      if (!silent) setConnectionsLoading(false)
    }
  }

  /**
   * Refresh the `~/.ssh/config` host list (the Host re-reads the file on every
   * call). Same generation + abort guard as the directory pane so closing the
   * dialog or a rapid retry can never apply a stale answer.
   */
  const refreshConfigHosts = async (silent = false): Promise<void> => {
    if (!silent) setConfigLoading(true)
    const current = configGeneration.current += 1
    const controller = new AbortController()
    configRequest.current = controller
    try {
      const value = unwrap(await rpc('config.hosts', {}, controller.signal), 'config.hosts failed')
      if (current !== configGeneration.current || controller.signal.aborted) return
      setConfigHosts(asConfigHosts(value))
      setConfigError(null)
    } catch (error) {
      if (current !== configGeneration.current || controller.signal.aborted) return
      setConfigError(error instanceof Error ? error.message : String(error))
    } finally {
      if (current === configGeneration.current && !silent) setConfigLoading(false)
    }
  }

  /** Open: refresh both sidebar lists and land on the local home. Closed: abort. */
  useEffect(() => {
    if (!open) {
      generation.current += 1
      activeRequest.current?.abort()
      activeRequest.current = null
      configGeneration.current += 1
      configRequest.current?.abort()
      configRequest.current = null
      return
    }
    generation.current += 1
    setPane(EMPTY_PANE)
    setFolderDraft(null)
    setFormOpen(false)
    setFormDraft(undefined)
    setOpeningRemote(false)
    setDeleteTarget(null)
    setRemovingId(null)
    setHostPending(null)
    setHostError(null)
    setConfirmTarget(null)
    setNativePicking(false)
    setMode({ kind: 'local' })
    void refreshConnections()
    void refreshConfigHosts()
    void loadLevel(signal => listLocalDirectory(undefined, signal))
  }, [open])

  /** The active connection view (undefined while browsing locally). */
  const activeConnection = mode.kind === 'remote' ? connections.find(connection => connection.id === mode.id) : undefined

  const activePath = pane.path ?? ''

  const refreshCurrent = (): void => {
    if (modeRef.current.kind === 'local') navigateLocal(paneRef.current.path ?? undefined)
    else navigateRemote(modeRef.current.id, paneRef.current.path ?? undefined)
  }

  /** One OS folder chooser on the host display; a pick lands straight as the workspace. */
  const pickNative = async (): Promise<void> => {
    if (mode.kind !== 'local' || nativePicking) return
    setNativePicking(true)
    try {
      const result = unwrap(await rpc('local.pickNative'), 'local.pickNative failed')
      const path = isRecord(result) && typeof result.path === 'string' ? result.path : ''
      if (path !== '') onPicked(path)
    } catch (error) {
      setPane(previous => ({ ...previous, error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setNativePicking(false)
    }
  }

  /** The registry entry a config alias points at, if it was registered before. */
  const matchConfigHost = (host: ConfigHostView): ConnectionView | undefined =>
    connections.find(connection =>
      connection.port === host.port
      && (connection.host.toLowerCase() === host.alias.toLowerCase()
        || connection.host.toLowerCase() === host.host.toLowerCase()))

  const openForm = (draft?: ConnectionDraft): void => {
    setFormDraft(draft)
    setFormOpen(true)
  }

  /**
   * One click on a config host: switch to its registered entry when there is
   * one; otherwise resolve the alias first. A missing username routes to the
   * prefilled form (the registry refuses empty usernames); anything else asks
   * for confirmation before it is registered and browsed.
   */
  const activateConfigHost = async (host: ConfigHostView): Promise<void> => {
    if (hostPending !== null) return
    const existing = matchConfigHost(host)
    if (existing !== undefined) {
      setHostError(null)
      navigateRemote(existing.id)
      return
    }
    setHostError(null)
    setHostPending(host.alias)
    try {
      const resolved = asResolved(unwrap(await rpc('connections.resolve', { host: host.alias }), 'connections.resolve failed'))
      if (resolved.host === '') throw new Error('别名解析结果为空')
      if (resolved.username.trim() === '') {
        openForm({
          label: host.alias,
          host: resolved.host,
          port: String(resolved.port),
          username: '',
          ...(resolved.privateKeyPaths[0] !== undefined ? { privateKeyPath: resolved.privateKeyPaths[0] } : {}),
          ...(resolved.jump.length > 0 ? { jumpText: resolved.jump.map(hop => `${hop.username !== undefined && hop.username !== '' ? `${hop.username}@` : ''}${hop.host}${hop.port !== undefined && hop.port !== 22 ? `:${String(hop.port)}` : ''}`).join(', ') } : {}),
          focusUsername: true,
        })
        return
      }
      setConfirmTarget({ host, resolved })
    } catch (error) {
      setHostError({ alias: host.alias, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setHostPending(null)
    }
  }

  /** Confirmed: register the config host and browse its home right away. */
  const confirmAddHost = async (): Promise<void> => {
    if (confirmTarget === null || hostPending !== null) return
    const { host, resolved } = confirmTarget
    setHostError(null)
    setHostPending(host.alias)
    try {
      const result = await rpc('connections.add', {
        label: host.alias,
        host: resolved.host,
        port: resolved.port,
        username: resolved.username,
        ...(resolved.privateKeyPaths[0] !== undefined ? { privateKeyPath: resolved.privateKeyPaths[0] } : {}),
        ...(resolved.jump.length > 0 ? { jump: resolved.jump } : {}),
      })
      const view = asAddedView(unwrap(result, 'connections.add failed'))
      if (view.id === '') throw new Error('注册结果缺少连接 id')
      setConfirmTarget(null)
      await refreshConnections(true)
      await refreshConfigHosts(true)
      navigateRemote(view.id)
    } catch (error) {
      setConfirmTarget(null)
      setHostError({ alias: host.alias, message: error instanceof Error ? error.message : String(error) })
    } finally {
      setHostPending(null)
    }
  }

  /** A prefilled form for the connection whose browse just failed on auth. */
  const draftFromConnection = (connection: ConnectionView): ConnectionDraft => ({
    label: connection.label,
    host: connection.host,
    port: String(connection.port),
    username: connection.username,
    ...(connection.jumpHosts.length > 0 ? { jumpText: connection.jumpHosts.join(', ') } : {}),
  })

  const confirmCreateFolder = async (): Promise<void> => {
    const name = (folderDraft ?? '').trim()
    if (name === '' || pane.path === null) return
    if (name === '.' || name === '..' || /[/\\]/.test(name)) {
      setFolderError('名称不能包含 / 或 \\，也不能是 . 或 ..')
      return
    }
    setFolderBusy(true)
    setFolderError(null)
    try {
      if (mode.kind === 'local') {
        await createLocalDirectory(pane.path, name)
      } else {
        unwrap(await rpc('browse.mkdir', { id: mode.id, path: pane.path, name }), 'browse.mkdir failed')
      }
      setFolderDraft(null)
      refreshCurrent()
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : String(error))
    } finally {
      setFolderBusy(false)
    }
  }

  const confirmRemove = async (): Promise<void> => {
    if (deleteTarget === null || removingId !== null) return
    setRemovingId(deleteTarget.id)
    try {
      unwrap(await rpc('connections.remove', { id: deleteTarget.id }), 'connections.remove failed')
      await refreshConnections(true)
      await refreshConfigHosts(true)
      if (mode.kind === 'remote' && mode.id === deleteTarget.id) {
        setMode({ kind: 'local' })
        void loadLevel(signal => listLocalDirectory(undefined, signal))
      }
    } catch (error) {
      setConnectionsError(error instanceof Error ? error.message : String(error))
    } finally {
      setRemovingId(null)
      setDeleteTarget(null)
    }
  }

  const formResolve = async (host: string): Promise<ResolvedSshConfigView> =>
    unwrap(await rpc('connections.resolve', { host }), 'connections.resolve failed')

  const formTest = async (input: ConnectionInputWire): Promise<{ ok: boolean; message?: string }> => {
    const result = await rpc('connections.test', input)
    if (result.ok) return { ok: true }
    return { ok: false, message: result.error.message }
  }

  const formSave = async (input: ConnectionInputWire): Promise<{ ok: boolean; message?: string; view?: ConnectionView }> => {
    const result = await rpc('connections.add', input)
    if (!result.ok) return { ok: false, message: result.error.message }
    const view = asAddedView(result.value)
    return { ok: true, ...(view.id !== '' ? { view } : {}) }
  }

  const formSaved = async (view: ConnectionView): Promise<void> => {
    setFormOpen(false)
    setFormDraft(undefined)
    await refreshConnections(true)
    await refreshConfigHosts(true)
    navigateRemote(view.id)
  }

  const hiddenCount = (pane.listing?.entries ?? []).filter(entry => entry.hidden).length
  const visibleEntries = (pane.listing?.entries ?? []).filter(entry => showHidden || !entry.hidden)
  const home = pane.listing?.home ?? ''
  const crumbs = pane.listing?.crumbs ?? []
  const lastCrumbIndex = crumbs.length - 1

  const subtitle = mode.kind === 'local'
    ? '选择一个本机目录作为新工作区'
    : `正在浏览 ${activeConnection !== undefined ? `${activeConnection.username}@${activeConnection.host}:${activeConnection.port}` : mode.id} 的远程目录`

  /** The translated remote failure for the right pane, when there is one. */
  const remoteFailure = mode.kind === 'remote' && pane.error !== null ? describeRemoteFailure(pane.error) : null

  if (!open) return null

  return (
    <div className={styles.overlay} onClick={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="选择工作区目录" ref={dialogRef}>
        <header className={styles.header}>
          <div className={styles.headerText}>
            <h3 className={styles.title}>选择工作区目录</h3>
            <p className={styles.subtitle}>{subtitle}</p>
          </div>
          <button type="button" className={styles.iconButton} aria-label="关闭" onClick={onCancel}>
            <CloseIcon />
          </button>
        </header>

        <div className={styles.body}>
          <nav className={styles.sidebar} aria-label="连接与位置">
            <section className={styles.sidebarSection} aria-label="本机">
              <ul className={styles.connectionList} role="list">
                <li className={cx(styles.connectionItem, mode.kind === 'local' && styles.connectionItemActive)}>
                  <button
                    type="button"
                    className={styles.connectionMain}
                    aria-current={mode.kind === 'local' ? 'true' : 'false'}
                    onClick={() => { if (mode.kind !== 'local') navigateLocal() }}
                  >
                    <MonitorIcon className={styles.connectionIcon} />
                    <span className={styles.connectionInfo}>
                      <span className={styles.connectionLabel}>本机目录</span>
                      <span className={styles.connectionDetail}>
                        <span className={styles.connectionEndpoint}>选择本机目录作为工作区</span>
                      </span>
                    </span>
                  </button>
                </li>
              </ul>
            </section>

            <section className={styles.sidebarSection} aria-label="已保存连接">
              <h4 className={styles.sidebarTitle}>
                已保存连接
                {connections.length > 0 && <span className={styles.sidebarCount}>{connections.length}</span>}
              </h4>

              {connectionsLoading && (
                <div role="status" aria-label="正在加载已保存连接">
                  {[0, 1].map(index => (
                    <div key={index} className={styles.skeletonRow}>
                      <div className={styles.skeletonDot} />
                      <div className={styles.skeletonLines}>
                        <div className={styles.skeletonLine} style={{ width: '38%' }} />
                        <div className={styles.skeletonLine} style={{ width: '62%' }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {connectionsError !== null && !connectionsLoading && (
                <div className={styles.sideError} role="alert">
                  <span className={styles.sideErrorText}>{connectionsError}</span>
                  <button type="button" className={styles.retryButton} onClick={() => { void refreshConnections() }}>
                    <RefreshIcon style={{ width: 12, height: 12 }} />
                    重试
                  </button>
                </div>
              )}

              {!connectionsLoading && connectionsError === null && connections.length === 0 && (
                <div className={styles.sideEmpty}>
                  <ServerIcon className={styles.sideEmptyIcon} style={{ width: 18, height: 18 }} />
                  <p className={styles.sideEmptyTitle}>还没有保存的连接</p>
                  <p className={styles.sideEmptyText}>点右下角「＋」新建，或从下方 SSH 配置主机一键添加。</p>
                </div>
              )}

              {!connectionsLoading && connections.length > 0 && (
                <ul className={styles.connectionList} role="list">
                  {connections.map(connection => {
                    const active = mode.kind === 'remote' && mode.id === connection.id
                    return (
                      <li key={connection.id} className={cx(styles.connectionItem, active && styles.connectionItemActive)}>
                        <button
                          type="button"
                          className={styles.connectionMain}
                          aria-current={active ? 'true' : 'false'}
                          onClick={() => { navigateRemote(connection.id) }}
                        >
                          <ServerIcon className={styles.connectionIcon} />
                          <span className={styles.connectionInfo}>
                            <span className={styles.connectionLabel}>{connection.label}</span>
                            <span className={styles.connectionDetail}>
                              <span className={styles.connectionEndpoint}>
                                {connection.username}@{connection.host}:{connection.port}
                              </span>
                              <span className={styles.badge}>
                                {connection.auth === 'password' ? <LockIcon style={{ width: 11, height: 11 }} /> : <KeyIcon style={{ width: 11, height: 11 }} />}
                                {connection.auth === 'password' ? '密码' : connection.auth === 'agent' ? 'Agent' : '私钥'}
                              </span>
                              {connection.jumpHosts.length > 0 && (
                                <span className={styles.badge} title={connection.jumpHosts.join(' → ')}>
                                  <RouteIcon style={{ width: 11, height: 11 }} />
                                  跳板 ×{connection.jumpHosts.length}
                                </span>
                              )}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className={styles.connectionRemove}
                          aria-label={`删除连接 ${connection.label}`}
                          title="删除连接"
                          onClick={() => { setDeleteTarget(connection) }}
                        >
                          <TrashIcon style={{ width: 14, height: 14 }} />
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <section className={styles.sidebarSection} aria-label="SSH 配置主机">
              <h4 className={styles.sidebarTitle}>
                SSH 配置主机
                {configHosts.length > 0 && <span className={styles.sidebarCount}>{configHosts.length}</span>}
              </h4>

              {configLoading && (
                <div role="status" aria-label="正在读取 ~/.ssh/config">
                  {[0, 1].map(index => (
                    <div key={index} className={styles.skeletonRow}>
                      <div className={styles.skeletonDot} />
                      <div className={styles.skeletonLines}>
                        <div className={styles.skeletonLine} style={{ width: '38%' }} />
                        <div className={styles.skeletonLine} style={{ width: '62%' }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {configError !== null && !configLoading && (
                <div className={styles.sideError} role="alert">
                  <span className={styles.sideErrorText}>无法读取 ~/.ssh/config：{configError}</span>
                  <button type="button" className={styles.retryButton} onClick={() => { void refreshConfigHosts() }}>
                    <RefreshIcon style={{ width: 12, height: 12 }} />
                    重试
                  </button>
                </div>
              )}

              {!configLoading && configError === null && configHosts.length === 0 && (
                <div className={styles.sideEmpty}>
                  <p className={styles.sideEmptyTitle}>未发现 SSH 配置主机</p>
                  <p className={styles.sideEmptyText}>在 ~/.ssh/config 中添加 Host 条目后，这里会直接列出，点击即可连接。</p>
                </div>
              )}

              {!configLoading && configHosts.length > 0 && (
                <ul className={styles.connectionList} role="list">
                  {configHosts.map(host => {
                    const registered = matchConfigHost(host)
                    const working = hostPending === host.alias
                    const failed = hostError !== null && hostError.alias === host.alias
                    return (
                      <li key={host.alias} className={styles.connectionItem}>
                        <button
                          type="button"
                          className={styles.connectionMain}
                          aria-current="false"
                          disabled={hostPending !== null}
                          title={registered !== undefined
                            ? `已注册为 ${registered.username}@${registered.host}:${registered.port}`
                            : host.username !== ''
                              ? `${host.username}@${host.host}:${host.port} — 点击注册并浏览`
                              : '未指定用户 — 点击打开表单补全'}
                          onClick={() => { void activateConfigHost(host) }}
                        >
                          <ServerIcon className={styles.connectionIcon} />
                          <span className={styles.connectionInfo}>
                            <span className={styles.connectionLabel}>{host.alias}</span>
                            <span className={styles.connectionDetail}>
                              {working ? (
                                <span className={styles.hostWorking}>
                                  <SpinnerIcon className={cx(styles.spin, styles.hostSpinner)} />
                                  正在添加并连接…
                                </span>
                              ) : failed && hostError !== null ? (
                                <span className={styles.hostErrorText} role="alert">添加失败：{hostError.message}</span>
                              ) : (
                                <>
                                  <span className={styles.connectionEndpoint}>
                                    {host.username !== '' ? `${host.username}@${host.host}:${host.port}` : '未指定用户'}
                                  </span>
                                  {registered !== undefined ? (
                                    <span className={cx(styles.badge, styles.badgeAdded)}>
                                      <CheckIcon style={{ width: 11, height: 11 }} />
                                      已添加
                                    </span>
                                  ) : (
                                    <>
                                      {host.identityFile && (
                                        <span className={styles.badge}>
                                          <KeyIcon style={{ width: 11, height: 11 }} />
                                          私钥
                                        </span>
                                      )}
                                      {host.jump && (
                                        <span className={styles.badge}>
                                          <RouteIcon style={{ width: 11, height: 11 }} />
                                          跳板
                                        </span>
                                      )}
                                    </>
                                  )}
                                </>
                              )}
                            </span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <button
              type="button"
              className={styles.sidebarAdd}
              aria-label="新建连接"
              title="新建连接"
              onClick={() => { openForm() }}
            >
              <PlusIcon style={{ width: 14, height: 14 }} />
            </button>
          </nav>

          <div className={styles.main}>
            <div className={styles.toolbar}>
              <nav className={styles.crumbs} aria-label="当前路径">
                <button
                  type="button"
                  className={styles.crumb}
                  aria-label="回到主目录"
                  title="主目录"
                  disabled={home === '' || pane.loading}
                  onClick={() => {
                    if (mode.kind === 'local') navigateLocal(home)
                    else navigateRemote(mode.id, home)
                  }}
                >
                  <HomeIcon style={{ width: 13, height: 13, verticalAlign: '-2px' }} />
                </button>
                {crumbs.map((crumb, index) =>
                  index === lastCrumbIndex ? (
                    <span key={crumb.path} className={styles.crumbCurrent} aria-current="page" title={crumb.path}>
                      {crumb.name}
                    </span>
                  ) : (
                    <span key={crumb.path} className={styles.crumbStep}>
                      <button
                        type="button"
                        className={styles.crumb}
                        disabled={pane.loading}
                        onClick={() => {
                          if (mode.kind === 'local') navigateLocal(crumb.path)
                          else navigateRemote(mode.id, crumb.path)
                        }}
                      >{crumb.name}</button>
                      <span className={styles.crumbSep} aria-hidden>/</span>
                    </span>
                  ),
                )}
              </nav>
          <div className={styles.toolbarActions}>
            {mode.kind === 'local' && (
              <button
                type="button"
                className={cx(styles.toolButton, styles.toolButtonText)}
                aria-label="用系统选择器选择文件夹"
                title="打开系统文件夹选择器"
                disabled={nativePicking || busy}
                onClick={() => { void pickNative() }}
              >
                {nativePicking ? <SpinnerIcon className={styles.spin} /> : <FolderIcon style={{ width: 13, height: 13 }} />}
                系统选择器
              </button>
            )}
            <button
                  type="button"
                  className={styles.toolButton}
                  aria-label="在当前目录新建文件夹"
                  title="新建文件夹"
                  disabled={pane.listing === null || pane.loading}
                  onClick={() => {
                    setFolderDraft('')
                    setFolderError(null)
                  }}
                >
                  <FolderPlusIcon />
                </button>
                <button
                  type="button"
                  className={cx(styles.toolButton, showHidden && styles.toolButtonOn)}
                  aria-pressed={showHidden}
                  aria-label={showHidden ? '隐藏以点开头的文件夹' : '显示以点开头的文件夹'}
                  title={showHidden ? '隐藏点开头的文件夹' : '显示点开头的文件夹'}
                  onClick={() => { setShowHidden(previous => !previous) }}
                >
                  <EyeIcon />
                  {!showHidden && hiddenCount > 0 && <span className={styles.countBadge} aria-hidden>{hiddenCount}</span>}
                </button>
                <button
                  type="button"
                  className={styles.toolButton}
                  aria-label="刷新当前目录"
                  title="刷新"
                  disabled={pane.loading || pane.listing === null}
                  onClick={refreshCurrent}
                >
                  <RefreshIcon className={pane.loading ? styles.spin : undefined} />
                </button>
              </div>
            </div>

            <div
              className={cx(styles.browser, pane.loading && pane.listing !== null && styles.browserBusy)}
              aria-busy={pane.loading}
            >
              {pane.loading && pane.listing === null && (
                <div className={styles.skeletons} role="status" aria-label="正在加载目录">
                  {[52, 78, 64, 90, 45, 71].map((width, index) => (
                    <div key={index} className={styles.skeleton} style={{ width: `${width}%` }} />
                  ))}
                </div>
              )}

              {pane.error !== null && !pane.loading && (
                <div className={styles.errorPanel} role="alert">
                  <AlertIcon className={styles.errorIcon} />
                  <div className={styles.errorBody}>
                    <p className={styles.errorTitle}>
                      {remoteFailure !== null ? remoteFailure.title : mode.kind === 'remote' ? '无法读取远程目录' : '无法读取目录'}
                    </p>
                    <p className={styles.errorText}>{remoteFailure !== null ? remoteFailure.text : pane.error}</p>
                  </div>
                  <div className={styles.errorActions}>
                    {remoteFailure?.needsAuth === true && activeConnection !== undefined && (
                      <button
                        type="button"
                        className={styles.retryButton}
                        onClick={() => { openForm(draftFromConnection(activeConnection)) }}
                      >
                        <KeyIcon style={{ width: 12, height: 12 }} />
                        补全认证
                      </button>
                    )}
                    <button type="button" className={styles.retryButton} onClick={refreshCurrent}>
                      <RefreshIcon style={{ width: 12, height: 12 }} />
                      重试
                    </button>
                  </div>
                </div>
              )}

              {pane.listing !== null && visibleEntries.length === 0 && !pane.loading && pane.error === null && (
                <div className={styles.emptyState}>
                  <FolderIcon className={styles.emptyIcon} style={{ width: 22, height: 22 }} />
                  <p className={styles.emptyTitle}>没有子文件夹</p>
                  <p className={styles.emptyText}>
                    {hiddenCount > 0 && !showHidden
                      ? `另有 ${hiddenCount} 个点开头的文件夹未显示`
                      : '可直接在此目录新建文件夹，或选择上方路径'}
                  </p>
                </div>
              )}

              {visibleEntries.length > 0 && (
                <ul className={styles.entryList} role="list">
                  {visibleEntries.map(entry => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        className={cx(styles.entry, entry.hidden && styles.entryHidden)}
                        onClick={() => {
                          if (mode.kind === 'local') navigateLocal(entry.path)
                          else navigateRemote(mode.id, entry.path)
                        }}
                      >
                        <FolderIcon className={styles.entryIcon} />
                        <span className={styles.entryName}>{entry.name}</span>
                        <ChevronIcon className={styles.entryChevron} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {pane.listing?.truncated === true && (
                <p className={styles.truncated}>文件夹过多，仅显示开头部分。</p>
              )}
            </div>
          </div>
        </div>

        <footer className={styles.footer}>
          <button type="button" className={styles.button} disabled={busy} onClick={onCancel}>取消</button>
          <button
            type="button"
            className={cx(styles.button, styles.primary)}
            disabled={pane.listing === null || pane.loading || busy || openingRemote || pane.path === null}
            onClick={() => {
              if (pane.path === null) return
              if (mode.kind === 'local') onPicked(pane.path)
              else void openRemotePath()
            }}
          >
            {mode.kind === 'remote' && openingRemote && <SpinnerIcon className={styles.spin} />}
            {mode.kind === 'remote' ? (openingRemote ? '连接中…' : '连接并打开') : '选择目录'}
          </button>
        </footer>
      </div>

      {folderDraft !== null && (
        <div className={styles.overlay} onClick={(event) => { if (event.target === event.currentTarget && !folderBusy) setFolderDraft(null) }}>
          <div className={styles.smallDialog} role="dialog" aria-modal="true" aria-label="新建文件夹" ref={folderDialogRef}>
            <h3 className={styles.formTitle}>新建文件夹</h3>
            <p className={styles.createIn}>
              位置：<span className={cx(styles.mono, styles.createPath)}>{activePath === '' ? '…' : activePath}</span>
            </p>
            <input
              className={cx(styles.input, folderError !== null && styles.inputError)}
              value={folderDraft}
              placeholder="未命名文件夹"
              disabled={folderBusy}
              onChange={(event) => { setFolderDraft(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter' && !folderBusy) void confirmCreateFolder() }}
            />
            {folderError !== null && <p className={styles.fieldError} role="alert">{folderError}</p>}
            <div className={styles.formActions}>
              <span className={styles.gap} />
              <button type="button" className={styles.button} disabled={folderBusy} onClick={() => { setFolderDraft(null) }}>取消</button>
              <button
                type="button"
                className={cx(styles.button, styles.primary)}
                disabled={folderBusy || (folderDraft ?? '').trim() === ''}
                onClick={() => { void confirmCreateFolder() }}
              >
                {folderBusy && <SpinnerIcon className={styles.spin} />}
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteTarget !== null && (
        <div className={styles.overlay} onClick={(event) => { if (event.target === event.currentTarget && removingId === null) setDeleteTarget(null) }}>
          <div className={styles.smallDialog} role="dialog" aria-modal="true" aria-label="删除远程连接" ref={deleteDialogRef}>
            <div className={styles.confirmHead}>
              <span className={styles.confirmIconWrap}><TrashIcon /></span>
              <div>
                <h3 className={styles.formTitle}>删除连接「{deleteTarget.label}」？</h3>
                <p className={styles.confirmText}>
                  将移除 {deleteTarget.username}@{deleteTarget.host}:{deleteTarget.port} 的注册信息；删除后需要重新添加才能再次连接。
                </p>
              </div>
            </div>
            <div className={styles.formActions}>
              <span className={styles.gap} />
              <button type="button" className={styles.button} disabled={removingId !== null} onClick={() => { setDeleteTarget(null) }}>取消</button>
              <button
                type="button"
                className={cx(styles.button, styles.danger)}
                disabled={removingId !== null}
                onClick={() => { void confirmRemove() }}
              >
                {removingId !== null && <SpinnerIcon className={styles.spin} />}
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmTarget !== null && (
        <div className={styles.overlay} onClick={(event) => { if (event.target === event.currentTarget && hostPending === null) setConfirmTarget(null) }}>
          <div className={styles.smallDialog} role="dialog" aria-modal="true" aria-label="添加 SSH 配置主机" ref={confirmDialogRef}>
            <div className={styles.confirmHead}>
              <span className={cx(styles.confirmIconWrap, styles.confirmIconInfo)}><ServerIcon /></span>
              <div>
                <h3 className={styles.formTitle}>添加连接「{confirmTarget.host.alias}」？</h3>
                <p className={styles.confirmText}>
                  将把 {confirmTarget.resolved.username}@{confirmTarget.resolved.host}:{confirmTarget.resolved.port}
                  {confirmTarget.resolved.jump.length > 0 ? `（经 ${String(confirmTarget.resolved.jump.length)} 级跳板）` : ''}
                  保存到「已保存连接」，并打开它的远程目录。
                </p>
              </div>
            </div>
            <div className={styles.formActions}>
              <span className={styles.gap} />
              <button type="button" className={styles.button} disabled={hostPending !== null} onClick={() => { setConfirmTarget(null) }}>取消</button>
              <button
                type="button"
                className={cx(styles.button, styles.primary)}
                disabled={hostPending !== null}
                onClick={() => { void confirmAddHost() }}
              >
                {hostPending !== null && <SpinnerIcon className={styles.spin} />}
                添加并连接
              </button>
            </div>
          </div>
        </div>
      )}

      {formOpen && (
        <ConnectionForm
          resolve={formResolve}
          test={formTest}
          save={formSave}
          draft={formDraft}
          onClose={() => { setFormOpen(false); setFormDraft(undefined) }}
          onSaved={(view) => { void formSaved(view) }}
        />
      )}
    </div>
  )
}
