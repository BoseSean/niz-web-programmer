import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { KeyboardMode } from '../../transport/simulator'
import { versionLabel } from '../lib/describe'
import type { DeviceUi } from '../state/useDevice'
import { Icon } from './Icon'
import './ConnectionBar.css'

/**
 * What the page knows about the keyboard's mode. Only Program mode (M light on) reads and writes the custom bank, and
 * a real keyboard does not report its mode, so App infers it from reads and writes (the simulator says it outright).
 */
export type ModeHint = 'unknown' | 'program' | 'maybe-office' | 'office'

interface Props {
  device: DeviceUi
  onConnect: () => void
  onSimulator: () => void
  onDisconnect: () => void
  /** Sends the firmware version request (F9); only on the user's click. */
  onVersion: () => void
  onSimMode: (mode: KeyboardMode) => void
  /** 重试 after a failed open (reopens without the chooser). Falls back to onConnect when absent. */
  onRetry?: () => void
  /** The 自动连接 switch; hidden when absent or when WebHID is unavailable. */
  onAutoConnect?: (on: boolean) => void
  /** Closes the failure message. */
  onDismissFailure?: () => void
  /** The real keyboard's mode as App sees it (default 'unknown'); the simulator shows its own M switch instead. */
  modeHint?: ModeHint
  /** [M 灯亮着] after a read that returned the factory map: the user says it really is Program mode. */
  onConfirmProgram?: () => void
  /** [重新读取] in the mode popover; App decides whether that keeps or replaces the edits. */
  onReread?: () => void
  /** A write went in while the keyboard was in Office mode and is not verified yet (shown with modeHint 'office'). */
  pendingVerify?: boolean
  /** [M 灯已亮，重新校验] for that write. */
  onReverify?: () => void
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), summary, a[href]'
/** Room kept between a popover and the edge of the window. */
const GUTTER = 16

/**
 * A non-modal popover under its trigger. Opening it focuses its first control (or the popover itself when it only
 * explains), Esc closes it and gives focus back to the trigger, and a click or focus outside closes it.
 */
function usePopover() {
  const [open, setOpen] = useState(false)
  const id = useId()
  const anchor = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  // Right-aligned with the trigger where that fits, otherwise shifted so it stays inside the window.
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      const p = pop.current
      if (!a || !p) return
      const room = document.documentElement.clientWidth || window.innerWidth
      const left = Math.max(GUTTER, Math.min(a.right - p.offsetWidth, room - GUTTER - p.offsetWidth))
      p.style.left = `${Math.round(left - a.left)}px`
      p.style.right = 'auto'
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) return
    ;(pop.current?.querySelector<HTMLElement>(FOCUSABLE) ?? pop.current)?.focus()
    const onDown = (e: MouseEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // The focused control can go away while the popover stays open (查询 turns into the version): keep focus inside.
  useEffect(() => {
    if (open && pop.current && document.activeElement === document.body) pop.current.focus()
  })

  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  const anchorProps = {
    ref: anchor,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !open) return
      e.preventDefault()
      e.stopPropagation()
      close()
    },
    onBlur: (e: FocusEvent) => {
      if (open && e.relatedTarget && !anchor.current?.contains(e.relatedTarget as Node)) setOpen(false)
    },
  }
  const triggerProps = {
    ref: trigger,
    'aria-haspopup': 'dialog' as const,
    'aria-expanded': open,
    'aria-controls': open ? id : undefined,
    onClick: () => setOpen(!open),
  }
  const popProps = { ref: pop, id, role: 'dialog', tabIndex: -1 }
  return { open, close, anchorProps, triggerProps, popProps }
}

function AutoSwitch({ device, onChange, showHint = false }: { device: DeviceUi; onChange: (on: boolean) => void; showHint?: boolean }) {
  const hintId = useId()
  const hint = !device.autoConnect
    ? '已关闭：每次都需要点“连接键盘”'
    : device.autoPaused
      ? '已暂停：你在本页断开过，点“连接键盘”后恢复'
      : '打开本页或插上键盘时自动连接'
  return (
    <>
      <label className="conn-auto" title={showHint ? undefined : hint}>
      <input
        type="checkbox"
        role="switch"
        checked={device.autoConnect}
        onChange={(e) => onChange(e.currentTarget.checked)}
        aria-describedby={hintId}
      />
      <span className="conn-auto-track" aria-hidden="true">
        <span className="conn-auto-thumb" />
      </span>
      <span>自动连接</span>
      </label>
      <span id={hintId} className={showHint ? 'muted conn-pop-note' : 'sr-only'}>
        {hint}
      </span>
    </>
  )
}

function HidHint({ support }: { support: DeviceUi['support'] }) {
  if (support === 'ok') return null
  return (
    <p className="conn-hint" role="note">
      {support === 'insecure' ? (
        <>
          本页不是通过安全连接打开的，浏览器因此关闭了 WebHID，无法连接真实键盘。请改用 <b>https://</b> 地址，或在本机用{' '}
          <b>http://localhost</b> 打开（需要桌面版 <b>Chrome</b> 或 <b>Edge</b>）；也可以先用模拟键盘体验。
        </>
      ) : (
        <>
          当前浏览器不支持 WebHID，无法连接真实键盘。请用桌面版 <b>Chrome</b> 或 <b>Edge</b>，并通过 HTTPS 或 localhost
          打开本页；也可以先用模拟键盘体验。
        </>
      )}
    </p>
  )
}

/** The status pill of a live connection; it opens the 连接 popover (firmware, 自动连接, 断开). */
function ConnStatus({
  device,
  autoSwitch,
  onVersion,
  onDisconnect,
}: {
  device: DeviceUi
  autoSwitch: ReactNode
  onVersion: () => void
  onDisconnect: () => void
}) {
  const { open, anchorProps, triggerProps, popProps } = usePopover()
  const noteId = useId()
  const hid = device.support === 'ok'
  const version =
    device.busy?.op === 'version' ? '查询中…' : device.version === null ? '未知（键盘没有回应）' : device.version && versionLabel(device.version)
  return (
    <div className="conn-anchor" {...anchorProps}>
      <button type="button" className="conn-status conn-status-btn is-on" {...triggerProps}>
        <span className="led led-on" aria-hidden="true" />
        <span>
          已连接{' '}
          {device.kind === 'simulator' && (
            <>
              <span className="conn-kind conn-kind-simulator" title="页面内的模拟设备，不会改动真实键盘">
                模拟键盘
              </span>{' '}
            </>
          )}
          <b>{device.name}</b>
          {device.auto && <span className="muted conn-sub"> · 已自动连接</span>}
        </span>
        <Icon name="down" size={14} className="conn-caret" />
      </button>
      {open && (
        <div className="conn-pop" aria-label="连接" {...popProps}>
          <p className="conn-pop-row">
            {version !== undefined ? (
              `固件版本：${version}`
            ) : (
              <>
                固件版本：
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={onVersion}
                  disabled={device.busy !== null}
                  aria-label="查询固件版本"
                  title="向键盘查询固件版本，只读，不会改动键盘"
                >
                  查询
                </button>
              </>
            )}
          </p>
          {autoSwitch && <div className="conn-pop-switch">{autoSwitch}</div>}
          <div className="conn-pop-row">
            <button
              type="button"
              className="btn btn-sm"
              onClick={onDisconnect}
              disabled={device.busy !== null}
              aria-describedby={hid ? noteId : undefined}
            >
              <Icon name="disconnect" />
              断开
            </button>
          </div>
          {hid && (
            <p id={noteId} className="muted conn-pop-note">
              断开后，本页暂停自动连接，直到再次点“连接键盘”。
            </p>
          )}
        </div>
      )}
    </div>
  )
}

const CHIP: Record<ModeHint, { text: string; tone: string }> = {
  unknown: { text: 'M 灯 · 读取前请确认亮着', tone: '' },
  program: { text: '编程模式 · M 灯亮', tone: ' is-on' },
  'maybe-office': { text: '读到出厂键位 · M 灯亮着吗？', tone: ' is-warn' },
  office: { text: '办公模式 · M 灯灭', tone: ' is-warn' },
}

interface ModeActions {
  modeHint: ModeHint
  pendingVerify: boolean
  busy: boolean
  onConfirmProgram?: () => void
  onReread?: () => void
  onReverify?: () => void
}

/** The page's one explanation of the two banks, plus the next step the current mode calls for. */
function ModeHelp({ modeHint, pendingVerify, busy, onConfirmProgram, onReread, onReverify, close }: ModeActions & { close: () => void }) {
  const act = (fn: () => void) => () => {
    close()
    fn()
  }
  let next: ReactNode = null
  if (modeHint === 'maybe-office')
    next = (
      <>
        <p>灯不亮的话，先按住 Fn+F12 约 2 秒，灯亮后点“重新读取”。</p>
        <div className="mlight-pop-actions">
          {onConfirmProgram && (
            <button type="button" className="btn btn-sm" onClick={act(onConfirmProgram)}>
              M 灯亮着
            </button>
          )}
          {onReread && (
            <button type="button" className="btn btn-sm" onClick={act(onReread)} disabled={busy}>
              <Icon name="read" />
              重新读取
            </button>
          )}
        </div>
      </>
    )
  else if (modeHint === 'office' && pendingVerify)
    next = (
      <>
        <p>刚才写入的键位已经存进键盘，M 灯亮了才生效。</p>
        {onReverify && (
          <div className="mlight-pop-actions">
            <button type="button" className="btn btn-sm" onClick={act(onReverify)} disabled={busy}>
              <Icon name="check" />
              M 灯已亮，重新校验
            </button>
          </div>
        )}
      </>
    )
  else if (modeHint === 'office')
    next = (
      <>
        <p>M 灯亮后点“重新读取”，才能读到键盘里的键位。</p>
        {onReread && (
          <div className="mlight-pop-actions">
            <button type="button" className="btn btn-sm" onClick={act(onReread)} disabled={busy}>
              <Icon name="read" />
              重新读取
            </button>
          </div>
        )}
      </>
    )
  return (
    <>
      <p>键盘里存着两套键位：</p>
      <ul>
        <li>编程模式（F12 上的 M 灯亮）：用你写入的键位</li>
        <li>办公模式（M 灯灭）：用出厂键位</li>
      </ul>
      <p>本工具读写的是编程模式的键位。M 灯灭时，读取只能读到出厂键位，写入的改动也要等 M 灯亮了才生效。</p>
      <p>
        切换：按住 <kbd>Fn</kbd>+<kbd>F12</kbd> 约 2 秒。
      </p>
      {next && <div className="mlight-pop-next">{next}</div>}
    </>
  )
}

/**
 * The M light next to the status pill. A real keyboard does not report its mode, so its chip shows what App inferred
 * and opens the explanation; the simulator keeps its M switch (simulated Fn+F12), with the explanation beside it.
 */
function ModeChip({ device, onSimMode, ...actions }: ModeActions & { device: DeviceUi; onSimMode: (mode: KeyboardMode) => void }) {
  const { open, close, anchorProps, triggerProps, popProps } = usePopover()
  const popover = open && (
    <div className="mlight-pop" aria-label="编程模式和办公模式" {...popProps}>
      <ModeHelp {...actions} close={close} />
    </div>
  )

  if (device.kind === 'simulator') {
    const program = device.simMode === 'program'
    return (
      <div className="conn-anchor mlight-group" {...anchorProps}>
        <button
          type="button"
          className={`mlight${program ? ' is-on' : ''}`}
          onClick={() => onSimMode(program ? 'office' : 'program')}
          aria-pressed={program}
          title="模拟长按 Fn+F12：切换办公模式 / 编程模式"
        >
          <span className="mlight-led" aria-hidden="true">M</span>
          <span>{program ? '编程模式（M 灯亮）' : '办公模式（M 灯灭）'}</span>
        </button>
        <button type="button" className="icon-btn mlight-help" aria-label="两种模式的说明" {...triggerProps}>
          <Icon name="help" />
        </button>
        {popover}
      </div>
    )
  }

  const chip = actions.modeHint === 'office' && actions.pendingVerify ? { text: '已写入，未生效 · M 灯灭', tone: ' is-warn' } : CHIP[actions.modeHint]
  return (
    <div className="conn-anchor" {...anchorProps}>
      <button type="button" className={`mlight${chip.tone}`} {...triggerProps}>
        <span className="mlight-led" aria-hidden="true">M</span>
        <span>{chip.text}</span>
      </button>
      {popover}
    </div>
  )
}

export function ConnectionBar({
  device,
  onConnect,
  onSimulator,
  onDisconnect,
  onVersion,
  onSimMode,
  onRetry,
  onAutoConnect,
  onDismissFailure,
  modeHint = 'unknown',
  onConfirmProgram,
  onReread,
  pendingVerify = false,
  onReverify,
}: Props) {
  const hid = device.support === 'ok'
  const connecting = device.busy?.op === 'connect'
  const failure = device.failure
  const connectButton = useRef<HTMLButtonElement>(null)
  const simButton = useRef<HTMLButtonElement>(null)
  /** 断开 was pressed in the popover: once the bar shows 连接键盘 again, focus goes there instead of the page. */
  const refocus = useRef(false)
  useEffect(() => {
    if (device.connected || !refocus.current) return
    refocus.current = false
    ;(connectButton.current?.disabled ? simButton.current : connectButton.current)?.focus()
  }, [device.connected])

  if (!device.connected) {
    // A first visit cannot connect on its own: the browser needs the chooser once.
    const sub = connecting || !hid
      ? null
      : !device.granted
        ? ' · 第一次使用请点“连接键盘”，在弹窗里选 84EC-S'
        : device.autoConnect && device.autoPaused
          ? ' · 自动连接已暂停'
          : device.autoConnect
            ? ' · 插上键盘会自动连接'
            : null
    return (
      <div className="conn">
        <div className="conn-status" role="status">
          <span className={`led${connecting ? ' led-wait' : ''}`} aria-hidden="true" />
          <span>
            <span>{connecting ? '正在连接…' : '未连接'}</span>
            {sub && <span className="muted conn-sub">{sub}</span>}
          </span>
        </div>
        <button type="button" ref={connectButton} className="btn btn-primary" onClick={onConnect} disabled={!hid || connecting}>
          <Icon name="plug" />
          {connecting ? '正在连接…' : '连接键盘'}
        </button>
        <span className="conn-sim">
          <span className="muted">没有键盘？</span>
          <button type="button" ref={simButton} className="link-btn" onClick={onSimulator} disabled={connecting}>
            使用模拟键盘
          </button>
        </span>
        {hid && onAutoConnect && device.granted && <AutoSwitch device={device} onChange={onAutoConnect} />}
        {failure && (
          <div className={`conn-alert conn-alert-${failure.kind === 'busy' ? 'warn' : 'error'}`} role="alert">
            <Icon name="warn" className="conn-alert-icon" />
            <div className="conn-alert-body">
              <p>
                {failure.auto && <b>自动连接失败。</b>}
                {failure.message}
              </p>
              {failure.detail && (
                <details className="conn-detail">
                  <summary>详情</summary>
                  <p>{failure.detail}</p>
                </details>
              )}
            </div>
            <div className="conn-alert-actions">
              {failure.canRetry && (
                <button type="button" className="btn btn-sm" onClick={onRetry ?? onConnect} disabled={connecting}>
                  <Icon name="restore" />
                  重试
                </button>
              )}
              {onDismissFailure && (
                <button type="button" className="icon-btn conn-alert-close" onClick={onDismissFailure} aria-label="关闭提示">
                  <Icon name="x" />
                </button>
              )}
            </div>
          </div>
        )}
        <HidHint support={device.support} />
      </div>
    )
  }

  const busy = device.busy !== null
  return (
    <div className="conn">
      {/* Same element as the 未连接 status above, so screen readers hear the change. */}
      <div className="sr-only" role="status">
        {`已连接${device.kind === 'simulator' ? '模拟键盘' : '键盘'} ${device.name}`}
      </div>
      <ConnStatus
        device={device}
        autoSwitch={hid && onAutoConnect ? <AutoSwitch device={device} onChange={onAutoConnect} showHint /> : null}
        onVersion={onVersion}
        onDisconnect={() => {
          refocus.current = true
          onDisconnect()
        }}
      />
      <ModeChip
        device={device}
        onSimMode={onSimMode}
        modeHint={modeHint}
        pendingVerify={pendingVerify}
        busy={busy}
        onConfirmProgram={onConfirmProgram}
        onReread={onReread}
        onReverify={onReverify}
      />
    </div>
  )
}
