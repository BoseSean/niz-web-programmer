import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icon'

interface Props {
  title: ReactNode
  onClose?: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  /** Prevent closing (e.g. while writing). */
  locked?: boolean
  /** Extra class on the dialog box, for component styles scoped to one dialog. */
  className?: string
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/** The controls Tab can reach inside `root`. */
const focusables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[hidden], [inert]'))

/** Keeps Tab / Shift+Tab inside the dialog (also when focus was lost to the page, e.g. after a row was deleted). */
function trapTab(e: KeyboardEvent, root: HTMLElement) {
  const items = focusables(root)
  if (!items.length) {
    e.preventDefault()
    root.focus()
    return
  }
  const active = document.activeElement
  const inside = active instanceof Node && root.contains(active)
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey ? !inside || active === first || active === root : !inside || active === last) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
  }
}

/**
 * Gives focus back to `prev`, the element that had it when the dialog opened. When that one is gone or disabled (读取键盘
 * while the read it started runs), the nearest enabled control around where it was takes focus instead of <body>.
 */
function returnFocus(prev: HTMLElement | null, around: HTMLElement[]) {
  if (!prev || (prev.isConnected && !prev.matches(':disabled'))) return void prev?.focus?.()
  for (const box of around) {
    if (!box.isConnected) continue
    const items = focusables(box)
    // In the closest container that has one: the next control after prev, else the last before it (the first when
    // prev is gone).
    const next = prev.isConnected
      ? (items.find((el) => prev.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) ?? items[items.length - 1])
      : items[0]
    if (next) return void next.focus()
  }
}

/** Modal dialog on a dimmed paper backdrop. Escape and backdrop click close it unless locked; Tab stays inside. */
export function Dialog({ title, onClose, children, footer, wide, locked, className }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    // Where prev sits, closest first: the way back when prev itself is removed with its row or popover.
    const around: HTMLElement[] = []
    for (let el = prev?.parentElement; el; el = el.parentElement) around.push(el)
    ref.current?.focus()
    return () => returnFocus(prev, around)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && ref.current) trapTab(e, ref.current)
      else if (e.key === 'Escape' && !locked) {
        e.stopPropagation()
        onClose?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [locked, onClose])

  return (
    <div className="dlg-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !locked && onClose?.()}>
      <div
        className={`dlg${wide ? ' dlg-wide' : ''}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        ref={ref}
      >
        <header className="dlg-head">
          <h2>{title}</h2>
          {onClose && !locked && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
              <Icon name="x" />
            </button>
          )}
        </header>
        <div className="dlg-body">{children}</div>
        {footer && <footer className="dlg-foot">{footer}</footer>}
      </div>
    </div>
  )
}
