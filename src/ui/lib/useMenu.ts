import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * Open state and keyboard handling of a popup menu (a role="menu" holding role="menuitem" buttons with tabIndex -1).
 * Opening focuses the first item, ↑ ↓ Home End move, Esc closes and gives focus back to the trigger, Tab and a click
 * outside `root` close it. Attach `root` to the wrapper, `trigger` to the button and `pop` to the menu.
 */
export function useMenu() {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)

  // A menu near the right edge of a narrow window opens further left instead of running off the page.
  useLayoutEffect(() => {
    const el = pop.current
    if (!open || !el) return
    const r = el.getBoundingClientRect()
    const over = r.right - (Math.min(window.innerWidth, document.documentElement.clientWidth || Infinity) - 8)
    if (over > 0) el.style.left = `${-Math.min(over, Math.max(0, r.left - 8))}px`
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

  /** Closes and focuses the trigger (so a dialog opened from the menu gives focus back to it when it closes). */
  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  const onMenuKey = (e: ReactKeyboardEvent<HTMLElement>) => {
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
  const onTriggerKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault()
      setOpen(true)
    }
  }

  return { open, setOpen, root, trigger, pop, close, onMenuKey, onTriggerKey }
}
