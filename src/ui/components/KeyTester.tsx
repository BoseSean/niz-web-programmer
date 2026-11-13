import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { keyById } from '../../device/layout'
import type { SlotTable } from '../../protocol/slots'
import { formatInterval as fmtInterval, usePhysicalKeyEvents, type TesterEvent } from '../lib/keyEvents'
import { isTypingTarget } from '../lib/useKeyCapture'
import { Icon } from './Icon'
import './KeyTester.css'

interface Props {
  /** Capture keys while true (the panel can stay mounted and show the log while inactive). */
  active: boolean
  onClose: () => void
  /** Physical key ids to light up on the keyboard view: keys held now plus a short flash of the latest press. */
  onHighlight?: (keyIds: string[]) => void
  /** Table used to find which physical key produces a code: the keyboard's map from the last read (default: factory map). */
  table?: SlotTable
  /** Log size (default 300). */
  limit?: number
}

/** Two Esc presses this close together close the tester (one Esc is recorded like any other key). */
const ESC_EXIT_MS = 800

/** How long a tapped key stays lit on the keyboard view after its release (a macro's taps would be invisible otherwise). */
const FLASH_MS = 450

const hex = (v: number) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`)

const MOD_ZH: [keyof TesterEvent['mods'], string][] = [['ctrl', 'Ctrl'], ['shift', 'Shift'], ['alt', 'Alt'], ['meta', 'Win']]
const modText = (e: TesterEvent) => MOD_ZH.filter(([k]) => e.mods[k]).map(([, l]) => l).join('+')

const KIND_MARK: Record<TesterEvent['kind'], { mark: string; zh: string }> = {
  down: { mark: '↓', zh: '按下' },
  up: { mark: '↑', zh: '松开' },
  wheel: { mark: '◎', zh: '滚动' },
  move: { mark: '✥', zh: '移动' },
  blur: { mark: '‖', zh: '失焦' },
}

function entryDetail(e: TesterEvent): string {
  if (e.kind === 'wheel') return `${e.count > 1 ? `×${e.count} ` : ''}Δ${Math.round(e.dy || e.dx)}`
  if (e.kind === 'move') return `${e.dx >= 0 ? '→' : '←'}${Math.abs(e.dx)} ${e.dy >= 0 ? '↓' : '↑'}${Math.abs(e.dy)}`
  if (e.kind === 'up' && e.holdMs !== null) return `按住 ${fmtMs(e.holdMs)}`
  if (e.repeat) return '自动重复'
  return ''
}

function lineOf(e: TesterEvent): string {
  const mods = modText(e)
  return [
    fmtInterval(e.dt).padStart(10, ' '),
    KIND_MARK[e.kind].zh,
    e.zh,
    e.code,
    e.info ? hex(e.info.value) : '',
    e.kind === 'down' || e.kind === 'up' ? `key=${JSON.stringify(e.key)}` : '',
    mods && `[${mods}]`,
    entryDetail(e),
    e.blocked ? '(已拦截默认行为)' : '',
  ].filter(Boolean).join('  ')
}

/**
 * Key tester: shows what the computer receives from the physical keyboard, to check a written mapping or to find out
 * what an unknown device function does.
 */
export function KeyTesterPanel({ active, onClose, onHighlight, table, limit }: Props) {
  const [paused, setPaused] = useState(false)
  const [showRepeats, setShowRepeats] = useState(true)
  const [trackMove, setTrackMove] = useState(false)
  const [copied, setCopied] = useState(false)
  const capturing = active && !paused
  const kt = usePhysicalKeyEvents(capturing, { table, limit, trackMouseMove: trackMove })
  const stage = useRef<HTMLDivElement>(null)
  /** Moves focus to the stage after a mouse click, so a following Space / Enter is tested instead of re-clicking. */
  const refocus = (e: ReactMouseEvent) => {
    // Deferred: the browser may still move focus to the clicked control (or a label's checkbox) after this handler.
    if (e.detail > 0) setTimeout(() => stage.current?.focus({ preventScroll: true }), 0)
  }

  // Esc exits: twice in a row while testing (a single Esc is a key people want to test), once while paused.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  useEffect(() => {
    if (!active) return
    let lastEsc = -Infinity
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      if (isTypingTarget(e.target)) return // Esc in a text field clears / leaves it
      const now = Date.now()
      if (paused || now - lastEsc < ESC_EXIT_MS) {
        e.preventDefault()
        onCloseRef.current()
      } else lastEsc = now
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, paused])

  // Focus the stage when capture starts so Space / Enter do not activate whatever button had focus.
  useEffect(() => {
    if (capturing) stage.current?.focus({ preventScroll: true })
  }, [capturing])

  // --- keyboard view highlight: held keys + a short flash of the latest press -------------------------------------
  // `expired` holds the flash key whose time is up, so no state is set synchronously in the effect.
  const [expired, setExpired] = useState('')
  const flashKey = kt.last && kt.last.keyIds.length ? `${kt.last.seq}|${kt.last.keyIds.join(',')}` : ''
  useEffect(() => {
    if (!flashKey) return
    const t = setTimeout(() => setExpired(flashKey), FLASH_MS)
    return () => clearTimeout(t)
  }, [flashKey])
  const flash = useMemo(() => (flashKey && flashKey !== expired ? flashKey.split('|')[1].split(',') : []), [expired, flashKey])
  const highlight = useMemo(() => (capturing ? [...new Set([...kt.heldKeyIds, ...flash])].sort() : []), [capturing, flash, kt.heldKeyIds])
  const highlightKey = highlight.join(',')
  const onHighlightRef = useRef(onHighlight)
  useEffect(() => {
    onHighlightRef.current = onHighlight
  })
  useEffect(() => {
    onHighlightRef.current?.(highlightKey ? highlightKey.split(',') : [])
  }, [highlightKey])
  useEffect(() => () => onHighlightRef.current?.([]), [])

  const visible = useMemo(() => {
    const list = showRepeats ? kt.events : kt.events.filter((e) => !e.repeat)
    return [...list].reverse()
  }, [kt.events, showRepeats])

  const last = kt.last
  const lastHeld = last ? kt.held.find((h) => h.code === last.code) : undefined
  const lastKeys = last?.keyIds.map((id) => keyById(id)?.label ?? id).join(' / ')
  const locks = useMemo(() => [...kt.events].reverse().find((e) => e.locks)?.locks ?? null, [kt.events])

  const copy = async () => {
    const text = [...kt.events].map(lineOf).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="kt" aria-labelledby="kt-title">
      <header className="kt-head">
        <div>
          <p className="kt-eyebrow">诊断工具</p>
          <h2 id="kt-title">按键测试</h2>
        </div>
        <div className="kt-head-tools">
          <button
            type="button"
            className="btn btn-sm"
            onClick={(e) => {
              setPaused(!paused)
              refocus(e)
            }}
            disabled={!active}
          >
            {paused ? '继续测试' : '暂停'}
          </button>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭按键测试" title="关闭按键测试">
            <Icon name="x" />
          </button>
        </div>
      </header>

      <div
        ref={stage}
        className={`kt-stage${capturing ? ' is-live' : ''}`}
        tabIndex={0}
        role="group"
        aria-label={capturing ? '按键测试区：正在测试，直接按键盘' : '按键测试区：已暂停'}
        aria-describedby="kt-stage-hint"
      >
        <div className="kt-state">
          <span className="kt-dot" aria-hidden="true" />
          <b>{capturing ? '正在测试，直接按键盘' : active ? '测试已暂停' : '测试未开启'}</b>
        </div>
        <p id="kt-stage-hint" className="kt-stage-hint">
          {capturing
            ? '这里显示电脑实际收到的按键、鼠标与滚轮。按下的键会在键盘图上亮起。连按两次 Esc 退出测试。'
            : active ? '点“继续测试”后再按键；按 Esc 退出测试。' : '点“继续测试”后再按键。'}
        </p>

        <div className="kt-last" aria-live="polite" aria-atomic="true">
          {last ? (
            <>
              <span className={`kt-cap${lastHeld ? ' is-down' : ''}`} aria-hidden="true">{last.info?.short ?? (last.key.length === 1 ? last.key.toUpperCase() : '?')}</span>
              <div className="kt-last-text">
                <span className="kt-last-zh">{last.zh}</span>
                <span className="kt-last-en">{last.en !== last.zh ? last.en : ''}</span>
                {lastKeys && <span className="kt-last-key">键盘上的 {lastKeys}</span>}
                <span className="kt-last-meta">
                  {lastHeld ? '按住中' : last.kind === 'wheel' ? `${last.count} 格` : '已松开'}
                  {modText(last) && ` · 修饰键 ${modText(last)}`}
                  {lastHeld && lastHeld.repeatMs !== null && ` · 自动重复 ${lastHeld.repeats} 次，间隔 ${Math.round(lastHeld.repeatMs)} ms（约 ${Math.round(1000 / Math.max(1, lastHeld.repeatMs))} 次/秒）`}
                  {last.keyIds.length === 0 && last.source === 'key' && (table ? ' · 键盘里的键位中没有产生它的键' : ' · 出厂键位里没有产生它的键')}
                </span>
              </div>
            </>
          ) : (
            <p className="kt-last-empty">还没有收到按键。按键盘上任意一个键试试。</p>
          )}
        </div>
        {/* Outside the live region: the codes are details, not something to announce on every key. */}
        {last && (
          <details className="kt-last-more">
            <summary onClick={refocus}>详细</summary>
            <span className="kt-last-codes mono">
              {last.info ? <b>{hex(last.info.value)}</b> : <b className="kt-nocode">无设备代码</b>}
              <span>{last.code}</span>
              {last.source === 'key' && <span>key “{last.key}”</span>}
              {last.location > 0 && <span>{['', '左侧', '右侧', '小键盘'][last.location]}</span>}
            </span>
          </details>
        )}
      </div>

      <div className="kt-row">
        <h3>按住中</h3>
        <ul className="kt-held" aria-label="当前按住的键">
          {kt.held.length === 0 && <li className="kt-held-empty">无</li>}
          {kt.held.map((h) => (
            <li key={h.code} className="kt-chip">
              <span>{h.zh}</span>
              <span className="mono">{h.info ? hex(h.info.value) : h.code}</span>
            </li>
          ))}
        </ul>
      </div>

      <dl className="kt-stats" aria-label="统计">
        <div><dt>按下</dt><dd className="mono">{kt.counts.down}</dd></div>
        <div><dt>松开</dt><dd className="mono">{kt.counts.up}</dd></div>
        <div><dt>自动重复</dt><dd className="mono">{kt.counts.repeat}</dd></div>
        <div><dt>鼠标</dt><dd className="mono">{kt.counts.mouse}</dd></div>
        <div><dt>滚轮</dt><dd className="mono">{kt.counts.wheel}</dd></div>
      </dl>
      {locks && (
        <p className="kt-locks" aria-label="锁定键状态（应与键盘指示灯一致）">
          <span className={locks.capsLock ? 'is-on' : ''}>大写 {locks.capsLock ? '开' : '关'}</span>
          <span className={locks.numLock ? 'is-on' : ''}>数字 {locks.numLock ? '开' : '关'}</span>
          <span className={locks.scrollLock ? 'is-on' : ''}>滚动 {locks.scrollLock ? '开' : '关'}</span>
          <span className="muted">应与键盘指示灯一致</span>
        </p>
      )}

      <div className="kt-log">
        <div className="kt-log-tools">
          <h3>时间线</h3>
          <label className="kt-check" onClick={refocus}>
            <input type="checkbox" checked={showRepeats} onChange={(e) => setShowRepeats(e.target.checked)} />
            显示自动重复
          </label>
          <label className="kt-check" onClick={refocus}>
            <input type="checkbox" checked={trackMove} onChange={(e) => setTrackMove(e.target.checked)} />
            记录鼠标移动
          </label>
          <span className="kt-log-actions">
            <button type="button" className="btn btn-sm" onClick={(e) => { void copy(); refocus(e) }} disabled={!kt.events.length}>
              <Icon name={copied ? 'check' : 'copy'} size={14} />
              {copied ? '已复制' : '复制'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={(e) => { kt.clear(); refocus(e) }} disabled={!kt.events.length && !kt.held.length}>
              <Icon name="trash" size={14} />
              清空
            </button>
          </span>
        </div>
        <ol className="kt-list" aria-label={`事件记录，最新的在最上面，共 ${kt.events.length} 条`}>
          {visible.length === 0 && <li className="kt-list-empty muted">按下、松开、鼠标和滚轮事件会按时间记录在这里，并标出与上一条的间隔，可用来看宏的节奏和连发速度。</li>}
          {visible.map((e) => (
            <li key={e.seq} className={`kt-ev kt-ev-${e.kind}${e.repeat ? ' is-repeat' : ''}`}>
              <span className="kt-ev-dt mono">{fmtInterval(e.dt)}</span>
              <span className="kt-ev-kind" title={KIND_MARK[e.kind].zh} aria-label={KIND_MARK[e.kind].zh}>{KIND_MARK[e.kind].mark}</span>
              <span className="kt-ev-name">
                {e.zh}
                {modText(e) && e.source !== 'key' && <small> · {modText(e)}</small>}
              </span>
              <span className="kt-ev-code mono">{e.info ? hex(e.info.value) : e.kind === 'blur' ? '' : e.code}</span>
              <span className="kt-ev-detail mono">{entryDetail(e)}</span>
            </li>
          ))}
        </ol>
        <p className="kt-log-foot muted">最多保留最近 {limit ?? 300} 条。间隔 = 与上一条事件相隔的时间。</p>
      </div>

      <details className="kt-guide">
        <summary>如何试出未知功能（0xA0、0xA2、0xA3、0xAA、0xAB、0xCC）</summary>
        <ol>
          <li>写入前会自动备份，也可以在“方案”里导出文件。</li>
          <li>选一个 Fn 层上空闲的键（例如 Fn+H），在键位设置里选“按键”，搜索 <code>0xA2</code> 之类的代码并选中。</li>
          <li>写入键盘，确认 F12 上的 M 灯亮着（编程模式）。</li>
          <li>打开这里的按键测试，按住 Fn 再按那个键，同时看：这里有没有收到事件、收到的是什么；键盘上的指示灯有没有变化；系统有没有反应（音量、亮度、蓝牙等）。</li>
          <li>什么都没收到也是结果：说明它是只在键盘内部起作用的功能，或电脑把它交给了系统处理。把时间线“复制”下来记录。</li>
          <li>试完把键位改回去，或在“方案”里把自动备份载入到页面，再写入键盘。</li>
        </ol>
      </details>

      <details className="kt-guide">
        <summary>哪些按键会被拦截，哪些收不到</summary>
        <ul>
          <li>测试时会拦截会让页面滚动、后退、刷新或打开浏览器功能的按键（空格、方向键、PgUp/PgDn、Backspace、F5、Alt+←、Ctrl+F/S/P、缩放、鼠标中键和侧键等），以及本页的 Ctrl+Z / Ctrl+Y，避免误改键位。</li>
          <li>永远不会拦截：Ctrl+W、Ctrl+T、Ctrl+N、Ctrl+Tab、Ctrl+1…9、Alt+F4、Alt+Tab、Win 键组合、Tab 和 F12，你随时可以关掉页面或切换窗口。</li>
          <li>有些键由操作系统直接处理，可能根本不会到达网页：计算器、我的电脑、邮件、睡眠、电源、唤醒、Win+L 等；音量和播放键在部分系统上也只有系统能收到。收不到不代表键位没写进去，请同时观察系统反应。</li>
          <li>Windows 上 PrtSc 往往只有“松开”事件；按下 Win 键、Alt+Tab 会让页面失去焦点，按住的键会被清空。</li>
          <li>Fn 键本身不会发送给电脑，只改变其他键的功能。</li>
        </ul>
      </details>
    </section>
  )
}
