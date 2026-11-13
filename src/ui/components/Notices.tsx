import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import './Notices.css'

export type Tone = 'info' | 'ok' | 'warn' | 'error'

/** What a notice is about; App keeps one notice per topic. */
export type NoticeTopic = 'connection' | 'read' | 'write' | 'file' | 'edit'

export interface NoticeAction {
  label: string
  onClick: () => void
}

export interface Notice {
  id: number
  tone: Tone
  title: string
  body?: ReactNode
  actions?: NoticeAction[]
  topic?: NoticeTopic
  /** Stays until it is closed (no timer, and App does not close it on the next edit). */
  sticky?: boolean
  /**
   * Closes by itself after this many ms. Never while it holds the keyboard focus or the pointer is on the stack: the
   * time starts again once they leave.
   */
  timeout?: number
}

const ICON: Record<Tone, IconName> = { info: 'info', ok: 'check', warn: 'warn', error: 'error' }

/** Notices shown at once; older ones fold into 「还有 n 条」. */
const VISIBLE = 2

interface Props {
  /** Newest first. */
  items: Notice[]
  onDismiss: (id: number) => void
  /** Where focus goes when the notice that held it closes and no other notice is left (a toolbar button, say). */
  fallbackFocus?: () => HTMLElement | null | undefined
}

function NoticeCard({ n, paused, onDismiss }: { n: Notice; paused: boolean; onDismiss: (id: number) => void }) {
  const [focused, setFocused] = useState(false)
  const { id, timeout } = n
  // The time runs from the render that shows the notice (or releases it), not from a later effect flush.
  useLayoutEffect(() => {
    if (!timeout || paused || focused) return
    const t = setTimeout(() => onDismiss(id), timeout)
    return () => clearTimeout(t)
  }, [focused, id, onDismiss, paused, timeout])

  return (
    <div
      className={`notice notice-${n.tone}`}
      role={n.tone === 'error' ? 'alert' : 'status'}
      data-notice={id}
      onFocus={() => setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocused(false)}
    >
      <Icon name={ICON[n.tone]} size={18} className="notice-icon" />
      <div className="notice-text">
        <strong>{n.title}</strong>
        {n.body && <div className="notice-body">{n.body}</div>}
        {n.actions && (
          <div className="row-actions">
            {n.actions.map((a) => (
              <button key={a.label} type="button" className="btn btn-sm" onClick={a.onClick}>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="icon-btn notice-close" onClick={() => onDismiss(id)} aria-label="关闭提示">
        <Icon name="x" size={14} />
      </button>
    </div>
  )
}

/**
 * Floating stack at the bottom left of the window: it never pushes the layout or covers the inspector beside the
 * board. At ≤980px, where the inspector sits under the board, Notices.css caps the stack's height and the page
 * reserves that much room at its bottom (full width along the bottom on phones). The newest notice sits lowest;
 * topics and what closes a notice on an edit are App's.
 */
export function Notices({ items, onDismiss, fallbackFocus }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [hover, setHover] = useState(false)
  const extra = items.length - VISIBLE
  if (expanded && extra <= 0) setExpanded(false)
  // Oldest first in the DOM, so reading and Tab order follow the stack from top to bottom.
  const shown = (expanded ? items : items.slice(0, VISIBLE)).toReversed()

  const root = useRef<HTMLDivElement>(null)
  /** The card (null: the 还有 n 条 button) that holds focus, and whether on its ×. Blur clears it; removal does not. */
  const holder = useRef<{ id: number | null; close: boolean } | null>(null)
  /** The cards as last rendered, oldest first. */
  const order = useRef<number[]>([])

  // What held focus went away under it (its own action or ×, a newer notice of its topic, 收起): focus the notice
  // that took its place (the × again after a ×), else the older one, else the caller's fallback; never <body>.
  useLayoutEffect(() => {
    const prev = order.current
    order.current = shown.map((n) => n.id)
    const h = holder.current
    const active = document.activeElement
    if (!h || (active && active !== document.body)) return
    holder.current = null
    const at = h.id === null ? -1 : prev.indexOf(h.id)
    const near = [...(h.id === null ? [] : [h.id]), ...prev.slice(at + 1), ...prev.slice(0, Math.max(at, 0)).reverse()]
    const card = near.map((id) => root.current?.querySelector(`[data-notice="${id}"]`)).find(Boolean) ?? root.current?.querySelector('.notice')
    ;(card?.querySelector<HTMLElement>(h.close ? '.notice-close' : 'button') ?? fallbackFocus?.())?.focus()
  })

  // The live region is always there, so the first notice is announced too.
  return (
    <div
      className="notice-stack"
      ref={root}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={(e) => {
        const card = e.target.closest<HTMLElement>('[data-notice]')
        holder.current = { id: card ? Number(card.dataset.notice) : null, close: e.target.classList.contains('notice-close') }
      }}
      onBlur={() => {
        holder.current = null
      }}
    >
      {extra > 0 && (
        <button type="button" className="notice-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : `还有 ${extra} 条`}
        </button>
      )}
      <div className="notice-stack-list" aria-live="polite">
        {shown.map((n) => (
          <NoticeCard key={n.id} n={n} paused={hover} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  )
}
