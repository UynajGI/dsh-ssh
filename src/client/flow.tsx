/**
 * The add-workspace directory flow of dsh-ssh: the local directory browser on
 * top, the SSH connection manager (「＋ 新建远程」) below. Remote levels browse
 * through the package's RPC channel; picking a remote directory hands the
 * owner an `ssh://<id><path>` workspace path, which the deployment's remote
 * providers consume (see README for the workspace-adoption seam).
 */

import { useEffect, useRef, useState } from 'react'
import type { ConnectionView, WireEntry, WireListing, WireResult } from './index.ts'
import { ConnectionForm } from './form.tsx'
import type { ConnectionInputWire, ResolvedSshConfigView } from './form.tsx'
import { cx, useDialogA11y } from './ui.ts'
import {
  AlertIcon,
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
  openRemoteSession(cwd: string): Promise<void>
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
  return {
    path: typeof record.path === 'string' ? record.path : '',
    home: typeof record.home === 'string' ? record.home : '',
    crumbs: Array.isArray(record.crumbs) ? record.crumbs.filter(isRecord).map(crumb => ({
      name: String(crumb.name ?? ''),
      path: String(crumb.path ?? ''),
      hidden: crumb.hidden === true,
    })) : [],
    entries: Array.isArray(record.entries) ? record.entries.filter(isRecord).map(entry => ({
      name: String(entry.name ?? ''),
      path: String(entry.path ?? ''),
      hidden: entry.hidden === true,
    })) : [],
    truncated: record.truncated === true,
  }
}

/** The directory-flow occupant registered into both workspace holes. */
export function SshWorkspaceFlow(props: FlowProps & FlowInjected) {
  const { open, busy, onPicked, onCancel, listLocalDirectory, createLocalDirectory, openRemoteSession, rpc } = props

  const [mode, setMode] = useState<Mode>({ kind: 'local' })
  const [pane, setPane] = useState<Pane>(EMPTY_PANE)
  const [connections, setConnections] = useState<ConnectionView[]>([])
  const [connectionsLoading, setConnectionsLoading] = useState(false)
  const [connectionsError, setConnectionsError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [folderDraft, setFolderDraft] = useState<string | null>(null)
  const [openingRemote, setOpeningRemote] = useState(false)
  const [folderBusy, setFolderBusy] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ConnectionView | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const generation = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)
  const modeRef = useRef<Mode>(mode)
  modeRef.current = mode
  const paneRef = useRef<Pane>(pane)
  paneRef.current = pane

  const dialogRef = useDialogA11y(open, () => { onCancel() })
  const folderDialogRef = useDialogA11y(folderDraft !== null, () => { if (!folderBusy) setFolderDraft(null) })
  const deleteDialogRef = useDialogA11y(deleteTarget !== null, () => { if (removingId === null) setDeleteTarget(null) })

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
      await openRemoteSession(`ssh://${mode.id}${pane.path}`)
      onCancel()
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
        const views = value.filter(isRecord).map(record => ({
          id: String(record.id ?? ''),
          label: String(record.label ?? ''),
          host: String(record.host ?? ''),
          port: typeof record.port === 'number' ? record.port : 22,
          username: String(record.username ?? ''),
          ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
          auth: (record.auth === 'password' || record.auth === 'agent' ? record.auth : 'key') as ConnectionView['auth'],
          jumpHosts: Array.isArray(record.jumpHosts) ? record.jumpHosts.map(String) : [],
        }))
        setConnections(views)
        setConnectionsError(null)
      }
    } catch (error) {
      setConnectionsError(error instanceof Error ? error.message : String(error))
    } finally {
      if (!silent) setConnectionsLoading(false)
    }
  }

  /** Open: refresh connections and land on the local home. Closed: abort pending work. */
  useEffect(() => {
    if (!open) {
      generation.current += 1
      activeRequest.current?.abort()
      activeRequest.current = null
      return
    }
    generation.current += 1
    setPane(EMPTY_PANE)
    setFolderDraft(null)
    setFormOpen(false)
    setOpeningRemote(false)
    setDeleteTarget(null)
    setRemovingId(null)
    setMode({ kind: 'local' })
    void refreshConnections()
    void loadLevel(signal => listLocalDirectory(undefined, signal))
  }, [open])

  /** The active connection view (undefined while browsing locally). */
  const activeConnection = mode.kind === 'remote' ? connections.find(connection => connection.id === mode.id) : undefined

  const activePath = pane.path ?? ''

  const refreshCurrent = (): void => {
    if (modeRef.current.kind === 'local') navigateLocal(paneRef.current.path ?? undefined)
    else navigateRemote(modeRef.current.id, paneRef.current.path ?? undefined)
  }

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
    const record = isRecord(result.value) ? result.value : {}
    const view = isRecord(record.view) ? record.view as unknown as ConnectionView : undefined
    return { ok: true, ...(view !== undefined ? { view } : {}) }
  }

  const formSaved = async (view: ConnectionView): Promise<void> => {
    setFormOpen(false)
    await refreshConnections(true)
    navigateRemote(view.id)
  }

  const hiddenCount = (pane.listing?.entries ?? []).filter(entry => entry.hidden).length
  const visibleEntries = (pane.listing?.entries ?? []).filter(entry => showHidden || !entry.hidden)
  const home = pane.listing?.home ?? ''
  const crumbs = pane.listing?.crumbs ?? []
  const lastCrumbIndex = crumbs.length - 1

  const subtitle = mode.kind === 'local'
    ? '选择一个本机目录作为新工作区'
    : '选择远程目录，将创建 SSH 远程会话'

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

        <div className={styles.tabs}>
          <button
            type="button"
            className={cx(styles.tab, mode.kind === 'local' && styles.tabOn)}
            aria-pressed={mode.kind === 'local'}
            onClick={() => { if (mode.kind !== 'local') navigateLocal() }}
          >
            <MonitorIcon className={styles.tabIcon} />
            <span className={styles.tabLabel}>本机</span>
          </button>
          {mode.kind === 'remote' && (
            <button
              type="button"
              className={cx(styles.tab, styles.tabOn)}
              aria-pressed
              title={activeConnection !== undefined ? `${activeConnection.username}@${activeConnection.host}:${activeConnection.port}` : mode.id}
            >
              <ServerIcon className={styles.tabIcon} />
              <span className={styles.tabLabel}>{activeConnection?.label ?? mode.id}</span>
            </button>
          )}
        </div>

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
                <p className={styles.errorTitle}>{mode.kind === 'remote' ? '无法读取远程目录' : '无法读取目录'}</p>
                <p className={styles.errorText}>{pane.error}</p>
              </div>
              <button type="button" className={styles.retryButton} onClick={refreshCurrent}>
                <RefreshIcon style={{ width: 12, height: 12 }} />
                重试
              </button>
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

        <section className={styles.remoteSection} aria-label="远程连接">
          <div className={styles.remoteHead}>
            <h4 className={styles.remoteTitle}>
              <ServerIcon className={styles.remoteTitleIcon} />
              远程连接
              {connections.length > 0 && <span className={styles.remoteCount}>{connections.length}</span>}
            </h4>
            <button type="button" className={styles.newRemote} onClick={() => { setFormOpen(true) }}>
              <PlusIcon style={{ width: 12, height: 12 }} />
              新建远程
            </button>
          </div>

          {connectionsLoading && (
            <div role="status" aria-label="正在加载远程连接">
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
            <div className={styles.remoteError} role="alert">
              <span className={styles.remoteErrorText}>{connectionsError}</span>
              <button type="button" className={styles.retryButton} onClick={() => { void refreshConnections() }}>
                <RefreshIcon style={{ width: 12, height: 12 }} />
                重试
              </button>
            </div>
          )}

          {!connectionsLoading && connectionsError === null && connections.length === 0 && (
            <div className={styles.remoteEmpty}>
              <ServerIcon className={styles.remoteEmptyIcon} style={{ width: 18, height: 18 }} />
              <p className={styles.remoteEmptyTitle}>还没有远程连接</p>
              <p className={styles.remoteEmptyText}>新建一个 SSH 连接，即可浏览远程目录并创建远程会话。</p>
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

        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.button}
            disabled={pane.listing === null || pane.loading || busy}
            onClick={() => {
              setFolderDraft('')
              setFolderError(null)
            }}
          >
            <FolderPlusIcon />
            新建文件夹
          </button>
          <span className={styles.gap} />
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

      {formOpen && (
        <ConnectionForm
          resolve={formResolve}
          test={formTest}
          save={formSave}
          onClose={() => { setFormOpen(false) }}
          onSaved={(view) => { void formSaved(view) }}
        />
      )}
    </div>
  )
}
