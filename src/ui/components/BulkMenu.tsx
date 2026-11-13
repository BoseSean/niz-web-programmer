import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import './BulkMenu.css'

interface Props {
  /** 全部改回出厂键位: both layers back to the factory map, on the page only (undoable). */
  onFactoryAll: () => void
  /** 全部清空… (opens a confirm dialog). */
  onClearAll: () => void
  /** While the keyboard is read or written: the menu cannot be opened. */
  disabled?: boolean
}

function MenuItem({ label, hint, close, onSelect }: { label: string; hint: string; close: () => void; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={() => {
        close()
        onSelect()
      }}
    >
      <span>{label}</span>
      <small>{hint}</small>
    </button>
  )
}

/**
 * ⋯ menu next to the keyboard legend: edits that change every key on the page at once.
 * Keyboard: opening focuses the first item, ↑ ↓ Home End move, Esc closes; focus returns to the ⋯ button
 * (so the 全部清空 dialog gives focus back to it when it closes).
 */
export function BulkMenu({ onFactoryAll, onClearAll, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  if (open && disabled) setOpen(false)

  // The menu opens leftwards from the button; where the legend has wrapped to the left edge it moves back in.
  useLayoutEffect(() => {
    const el = pop.current
    if (!open || !el) return
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.left < 8) el.style.right = `${r.left - 8}px`
  }, [open])

  useEffect(() => {
    if (!open) return
    pop.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(pop.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    const go = (n: number) => {
      e.preventDefault()
      items[(n + items.length) % items.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(-1)
    else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    } else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <div className="menu bulk-menu" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="icon-btn"
        aria-label="更多操作"
        title="全部改回出厂、全部清空"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="bulk-dots" aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div className="menu-pop bulk-pop" role="menu" aria-label="更多操作" ref={pop} onKeyDown={onMenuKey}>
          <MenuItem label="全部改回出厂键位" hint="只改页面上的键位，写入后才生效；可撤销" close={close} onSelect={onFactoryAll} />
          <MenuItem label="全部清空…" hint="两层键位全部设为“无”，默认保留 Fn 和模式切换；可撤销" close={close} onSelect={onClearAll} />
        </div>
      )}
    </div>
  )
}
