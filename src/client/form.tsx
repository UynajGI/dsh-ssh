/**
 * The 「新建连接」form: one SSH connection with password or private-key
 * authentication (二选一), an optional ProxyJump chain, and `~/.ssh/config`
 * alias recognition through the Host channel. The host field is alias-first:
 * blur or paste auto-resolves and prefills (the manual 「识别 ssh 配置」 button
 * stays as the loud fallback), and a successful resolve shows a one-line
 * summary (alias → user@host:port, identity file, jump chain). A `draft`
 * prefills the form — the sidebar opens it this way when a config host needs
 * its username or auth completed.
 */

import { useEffect, useRef, useState } from 'react'
import type { ConnectionView } from './index.ts'
import { cx, useDialogA11y } from './ui.ts'
import {
  AlertIcon,
  CheckIcon,
  CloseIcon,
  KeyIcon,
  LockIcon,
  RouteIcon,
  SparkIcon,
  SpinnerIcon,
} from './icons.tsx'
import styles from './flow.module.css'

/** One manual or resolved ProxyJump hop. */
export interface JumpInput {
  host: string
  port?: number
  username?: string
  privateKeyPath?: string
  agent?: string
}

/** The connection input the form assembles. */
export interface ConnectionInputWire {
  label?: string
  host: string
  port?: number
  username?: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  agent?: string
  jump?: JumpInput[]
  cwd?: string
}

/** The Host's `~/.ssh/config` resolution result. */
export interface ResolvedSshConfigView {
  host: string
  username: string
  port: number
  privateKeyPaths: string[]
  jump: JumpInput[]
  alias: string
}

/** Prefilled fields for a form opened from the sidebar (config host / auth fix). */
export interface ConnectionDraft {
  label?: string
  host?: string
  port?: string
  username?: string
  privateKeyPath?: string
  jumpText?: string
  cwd?: string
  /** Focus the username field on open (the missing piece the user must fill). */
  focusUsername?: boolean
}

export interface ConnectionFormProps {
  /** Resolve a host alias against the Host's `~/.ssh/config`. */
  resolve(host: string): Promise<ResolvedSshConfigView>
  /** Test the assembled input without persisting. */
  test(input: ConnectionInputWire): Promise<{ ok: boolean; message?: string }>
  /** Persist the assembled input; the added view arrives through `onSaved`. */
  save(input: ConnectionInputWire): Promise<{ ok: boolean; message?: string; view?: ConnectionView }>
  /** Prefilled fields, when the sidebar opened the form for one config host. */
  draft?: ConnectionDraft | undefined
  /** The operator dismissed the form. */
  onClose(): void
  /** A connection was saved; the flow switches the browser to it. */
  onSaved(view: ConnectionView): void
}

/** Parse a `[user@]host[:port]` jump list (comma/space separated). */
function parseJumpText(text: string): JumpInput[] {
  const entries = text.split(/[\s,]+/).map(entry => entry.trim()).filter(entry => entry !== '')
  return entries.map((entry): JumpInput => {
    let rest = entry
    let username: string | undefined
    let port: number | undefined
    const at = rest.lastIndexOf('@')
    if (at >= 0) {
      username = rest.slice(0, at)
      rest = rest.slice(at + 1)
    }
    const colon = rest.lastIndexOf(':')
    if (colon >= 0) {
      const parsed = Number(rest.slice(colon + 1))
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
        port = parsed
        rest = rest.slice(0, colon)
      }
    }
    return {
      host: rest,
      ...(port !== undefined ? { port } : {}),
      ...(username !== undefined && username !== '' ? { username } : {}),
    }
  })
}

/** Render one resolved hop as `user@host:port` (defaults hidden). */
function formatHop(hop: JumpInput): string {
  return `${hop.username !== undefined && hop.username !== '' ? `${hop.username}@` : ''}${hop.host}${hop.port !== undefined && hop.port !== 22 ? `:${String(hop.port)}` : ''}`
}

/** The one-line resolve summary: alias → user@host:port · identity · jumps. */
function formatSummary(resolved: ResolvedSshConfigView): string {
  const endpoint = `${resolved.username !== '' ? `${resolved.username}@` : ''}${resolved.host}${resolved.port !== 22 ? `:${String(resolved.port)}` : ''}`
  const parts: string[] = []
  if (resolved.alias.toLowerCase() !== resolved.host.toLowerCase()) parts.push(`${resolved.alias} → ${endpoint}`)
  else parts.push(endpoint)
  if (resolved.privateKeyPaths[0] !== undefined) parts.push(`私钥 ${resolved.privateKeyPaths[0] as string}`)
  if (resolved.jump.length > 0) parts.push(`跳板 ${resolved.jump.map(formatHop).join(' → ')}`)
  return parts.join(' · ')
}

type AuthKind = 'password' | 'key'

/** Typed feedback shown above the actions. */
interface Feedback {
  kind: 'info' | 'success' | 'error'
  text: string
}

/** Field-level validation errors (derived, shown after the first action). */
interface FieldErrors {
  host?: string
  port?: string
  username?: string
}

/** The connection form modal (masked password, 密码/私钥二选一). */
export function ConnectionForm({ resolve, test, save, draft, onClose, onSaved }: ConnectionFormProps) {
  const [label, setLabel] = useState(draft?.label ?? '')
  const [host, setHost] = useState(draft?.host ?? '')
  const [port, setPort] = useState(draft?.port ?? '22')
  const [username, setUsername] = useState(draft?.username ?? '')
  const [authKind, setAuthKind] = useState<AuthKind>('key')
  const [password, setPassword] = useState('')
  const [privateKeyPath, setPrivateKeyPath] = useState(draft?.privateKeyPath ?? '')
  const [passphrase, setPassphrase] = useState('')
  const [jumpText, setJumpText] = useState(draft?.jumpText ?? '')
  const [cwd, setCwd] = useState(draft?.cwd ?? '')
  const [busy, setBusy] = useState(false)
  const [busyTask, setBusyTask] = useState<'resolve' | 'test' | 'save' | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [resolveSummary, setResolveSummary] = useState<ResolvedSshConfigView | null>(null)
  const [autoBusy, setAutoBusy] = useState(false)

  const dialogRef = useDialogA11y(true, () => { if (!busy) onClose() })
  const usernameRef = useRef<HTMLInputElement | null>(null)
  const autoGeneration = useRef(0)
  const lastAutoHost = useRef<string | null>(null)
  const busyRef = useRef(false)
  busyRef.current = busy

  /** A prefilled form that is missing its username focuses that field first. */
  useEffect(() => {
    if (draft?.focusUsername === true) usernameRef.current?.focus()
  }, [draft?.focusUsername])

  const errors = (): FieldErrors => {
    const result: FieldErrors = {}
    if (host.trim() === '') result.host = '请填写主机名或 ~/.ssh/config 别名'
    const portText = port.trim()
    if (portText === '') result.port = '必填'
    else if (!/^\d+$/.test(portText)) result.port = '端口必须是数字'
    else {
      const value = Number(portText)
      if (value < 1 || value > 65535) result.port = '端口范围 1–65535'
    }
    if (username.trim() === '') result.username = '请填写登录用户名'
    return result
  }

  const errorOf = (key: keyof FieldErrors): string | undefined => (revealed ? errors()[key] : undefined)

  const assemble = (): ConnectionInputWire => {
    const jump = parseJumpText(jumpText)
    const input: ConnectionInputWire = {
      host: host.trim(),
      ...(port.trim() !== '' && Number.isInteger(Number(port.trim())) ? { port: Number(port.trim()) } : {}),
      ...(username.trim() !== '' ? { username: username.trim() } : {}),
      ...(label.trim() !== '' ? { label: label.trim() } : {}),
      ...(cwd.trim() !== '' ? { cwd: cwd.trim() } : {}),
      ...(jump.length > 0 ? { jump } : {}),
    }
    if (authKind === 'password' && password !== '') input.password = password
    if (authKind === 'key' && privateKeyPath.trim() !== '') input.privateKeyPath = privateKeyPath.trim()
    if (authKind === 'key' && passphrase !== '') input.passphrase = passphrase
    return input
  }

  /** Prefill every field the resolution covers; keep operator edits elsewhere. */
  const applyResolved = (resolved: ResolvedSshConfigView): void => {
    setHost(resolved.host)
    if (resolved.port !== 22) setPort(String(resolved.port))
    if (resolved.username !== '') setUsername(resolved.username)
    if (resolved.privateKeyPaths.length > 0) {
      setAuthKind('key')
      setPrivateKeyPath(resolved.privateKeyPaths[0] as string)
    }
    setJumpText(resolved.jump.map(formatHop).join(', '))
    const user = resolved.username !== '' ? resolved.username : username
    if (cwd.trim() === '' && user.trim() !== '') setCwd(`/home/${user.trim()}`)
    setResolveSummary(resolved)
  }

  /**
   * Silent alias resolution for blur/paste: no validation reveal, no error
   * surface, never disables the form. Guarded by its own generation counter
   * so a stale answer cannot clobber a newer edit.
   */
  const autoResolve = async (value: string): Promise<void> => {
    const hostText = value.trim()
    if (hostText === '' || busyRef.current) return
    if (lastAutoHost.current === hostText) return
    lastAutoHost.current = hostText
    const current = autoGeneration.current += 1
    setAutoBusy(true)
    try {
      const resolved = await resolve(hostText)
      if (current !== autoGeneration.current) return
      applyResolved(resolved)
    } catch {
      // Silent by design; the manual button reports the error.
    } finally {
      if (current === autoGeneration.current) setAutoBusy(false)
    }
  }

  const resolveConfig = async (): Promise<void> => {
    setRevealed(true)
    if (host.trim() === '') {
      setFeedback({ kind: 'error', text: '请先填写主机名或 ~/.ssh/config 别名' })
      return
    }
    autoGeneration.current += 1
    // Any in-flight silent resolve is now superseded; drop its spinner for good.
    setAutoBusy(false)
    setBusy(true)
    setBusyTask('resolve')
    setFeedback({ kind: 'info', text: '正在读取 ~/.ssh/config…' })
    try {
      const resolved = await resolve(host.trim())
      lastAutoHost.current = resolved.host
      applyResolved(resolved)
      setFeedback({
        kind: 'success',
        text: `已识别 ${resolved.alias} → ${resolved.username !== '' ? `${resolved.username}@` : ''}${resolved.host}${resolved.port !== 22 ? `:${String(resolved.port)}` : ''}`,
      })
    } catch (error) {
      setFeedback({ kind: 'error', text: `识别失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setBusy(false)
      setBusyTask(null)
    }
  }

  const runTest = async (): Promise<void> => {
    setRevealed(true)
    const input = assemble()
    if (host.trim() === '') {
      setFeedback({ kind: 'error', text: '请先填写主机名' })
      return
    }
    if (authKind === 'password' && input.password === undefined) {
      setFeedback({ kind: 'error', text: '请填写密码，或改用私钥认证' })
      return
    }
    if (authKind === 'key' && input.privateKeyPath === undefined) {
      setFeedback({ kind: 'error', text: '请填写私钥文件路径，或改用密码认证' })
      return
    }
    setBusy(true)
    setBusyTask('test')
    setFeedback({ kind: 'info', text: '正在测试连接…' })
    try {
      const outcome = await test(input)
      setFeedback(outcome.ok
        ? { kind: 'success', text: '连接成功，可以保存了' }
        : { kind: 'error', text: `连接失败：${outcome.message ?? '未知错误'}` })
    } catch (error) {
      setFeedback({ kind: 'error', text: `测试失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setBusy(false)
      setBusyTask(null)
    }
  }

  const runSave = async (): Promise<void> => {
    setRevealed(true)
    const found = errors()
    if (found.host !== undefined || found.port !== undefined || found.username !== undefined) {
      setFeedback({ kind: 'error', text: '请先补全上方必填项' })
      return
    }
    const input = assemble()
    setBusy(true)
    setBusyTask('save')
    setFeedback({ kind: 'info', text: '正在保存…' })
    try {
      const outcome = await save(input)
      if (!outcome.ok || outcome.view === undefined) {
        setFeedback({ kind: 'error', text: `保存失败：${outcome.message ?? '未知错误'}` })
        return
      }
      onSaved(outcome.view)
    } catch (error) {
      setFeedback({ kind: 'error', text: `保存失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setBusy(false)
      setBusyTask(null)
    }
  }

  const hostError = errorOf('host')
  const portError = errorOf('port')
  const usernameError = errorOf('username')

  return (
    <div className={styles.overlay} onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <div className={styles.form} role="dialog" aria-modal="true" aria-label="新建远程连接" ref={dialogRef}>
        <div className={styles.formHead}>
          <div className={styles.formHeadText}>
            <h3 className={styles.formTitle}>新建远程连接</h3>
            <p className={styles.formSub}>保存后将出现在连接侧栏中，可直接浏览其远程目录</p>
          </div>
          <button type="button" className={styles.iconButton} aria-label="关闭" disabled={busy} onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>主机名 / 别名<span className={styles.required} aria-hidden>*</span></span>
            <input
              className={cx(styles.input, hostError !== undefined && styles.inputError)}
              value={host}
              placeholder="prod 或 server.example.com"
              disabled={busy}
              onChange={event => {
                setHost(event.target.value)
                setResolveSummary(null)
                lastAutoHost.current = null
              }}
              onBlur={() => { void autoResolve(host) }}
              onPaste={event => {
                const text = event.clipboardData.getData('text')
                if (text.trim() !== '') void autoResolve(text)
              }}
            />
            {autoBusy && <span className={styles.fieldHint} role="status">正在匹配 ~/.ssh/config…</span>}
            {hostError !== undefined && <span className={styles.fieldError}>{hostError}</span>}
            <span className={styles.fieldHint}>填写 ~/.ssh/config 里的别名可在失焦时自动补全用户名、端口、私钥与跳板</span>
          </label>

          {resolveSummary !== null && (
            <div className={cx(styles.feedback, styles.feedbackSuccess)} role="status">
              <CheckIcon />
              <span className={styles.mono}>{formatSummary(resolveSummary)}</span>
            </div>
          )}

          <div className={styles.rowFields}>
            <label className={cx(styles.field, styles.fieldPort)}>
              <span className={styles.fieldLabel}>端口<span className={styles.required} aria-hidden>*</span></span>
              <input
                className={cx(styles.input, portError !== undefined && styles.inputError)}
                value={port}
                inputMode="numeric"
                disabled={busy}
                onChange={event => { setPort(event.target.value) }}
              />
              {portError !== undefined && <span className={styles.fieldError}>{portError}</span>}
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>用户名<span className={styles.required} aria-hidden>*</span></span>
              <input
                ref={usernameRef}
                className={cx(styles.input, usernameError !== undefined && styles.inputError)}
                value={username}
                disabled={busy}
                onChange={event => { setUsername(event.target.value) }}
              />
              {usernameError !== undefined && <span className={styles.fieldError}>{usernameError}</span>}
            </label>
          </div>

          <div className={styles.rowFields}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>名称（可选）</span>
              <input
                className={styles.input}
                value={label}
                placeholder="默认 user@host"
                disabled={busy}
                onChange={event => { setLabel(event.target.value) }}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>工作目录（可选）</span>
              <input
                className={styles.input}
                value={cwd}
                placeholder="/home/username"
                disabled={busy}
                onChange={event => { setCwd(event.target.value) }}
              />
            </label>
          </div>

          <div className={styles.fieldGroup}>
            <span className={styles.fieldLabel} id="dsh-ssh-auth-label">认证方式</span>
            <div className={styles.segment} role="radiogroup" aria-labelledby="dsh-ssh-auth-label">
              <button
                type="button"
                role="radio"
                aria-checked={authKind === 'key'}
                className={cx(styles.segmentButton, authKind === 'key' && styles.segmentButtonOn)}
                disabled={busy}
                onClick={() => { setAuthKind('key') }}
              >
                <KeyIcon />
                私钥文件
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={authKind === 'password'}
                className={cx(styles.segmentButton, authKind === 'password' && styles.segmentButtonOn)}
                disabled={busy}
                onClick={() => { setAuthKind('password') }}
              >
                <LockIcon />
                密码
              </button>
            </div>
          </div>

          {authKind === 'key' ? (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>私钥文件路径</span>
              <input
                className={styles.input}
                value={privateKeyPath}
                placeholder="~/.ssh/id_ed25519"
                disabled={busy}
                onChange={event => { setPrivateKeyPath(event.target.value) }}
              />
            </label>
          ) : (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>密码</span>
              <input
                type="password"
                className={styles.input}
                value={password}
                disabled={busy}
                onChange={event => { setPassword(event.target.value) }}
              />
            </label>
          )}

          {authKind === 'key' && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>私钥口令（可选）</span>
              <input
                type="password"
                className={styles.input}
                value={passphrase}
                disabled={busy}
                onChange={event => { setPassphrase(event.target.value) }}
              />
            </label>
          )}

          <label className={styles.field}>
            <span className={styles.fieldLabel}>跳板链（可选）</span>
            <input
              className={styles.input}
              value={jumpText}
              placeholder="bastion 或 user@bastion.example.com:2202，多台用逗号分隔"
              disabled={busy}
              onChange={event => { setJumpText(event.target.value) }}
            />
            <span className={styles.fieldHint}>支持 ~/.ssh/config 别名；格式 user@host:port，按连接顺序排列</span>
          </label>
        </div>

        {feedback !== null && (
          <div
            className={cx(
              styles.feedback,
              feedback.kind === 'success' ? styles.feedbackSuccess : feedback.kind === 'error' ? styles.feedbackError : styles.feedbackInfo,
            )}
            role={feedback.kind === 'error' ? 'alert' : 'status'}
          >
            {busy
              ? <SpinnerIcon className={styles.spin} />
              : feedback.kind === 'success'
                ? <CheckIcon />
                : feedback.kind === 'error'
                  ? <AlertIcon />
                  : null}
            <span>{feedback.text}</span>
          </div>
        )}

        <div className={styles.formActions}>
          <button type="button" className={styles.button} disabled={busy} onClick={() => { void resolveConfig() }}>
            <SparkIcon />
            识别 ssh 配置
          </button>
          <button type="button" className={styles.button} disabled={busy} onClick={() => { void runTest() }}>
            <RouteIcon />
            测试连接
          </button>
          <span className={styles.gap} />
          <button type="button" className={styles.button} disabled={busy} onClick={onClose}>取消</button>
          <button
            type="button"
            className={cx(styles.button, styles.primary)}
            disabled={busy}
            onClick={() => { void runSave() }}
          >
            {busyTask === 'save' && <SpinnerIcon className={styles.spin} />}
            保存连接
          </button>
        </div>
      </div>
    </div>
  )
}
