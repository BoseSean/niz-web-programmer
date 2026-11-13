import { useEffect, useRef } from 'react'

export interface CaptureHandlers {
  onDown: (e: KeyboardEvent) => void
  onUp?: (e: KeyboardEvent) => void
  /** The window lost focus (keys pressed elsewhere would be missed). */
  onBlur?: () => void
}

/**
 * While `active`, swallows every key event (capture phase, default prevented, propagation stopped) and hands it to
 * the handlers, so pressing Tab, F5 or Ctrl+W maps a key instead of acting on the page.
 */
export function useKeyCapture(active: boolean, handlers: CaptureHandlers): void {
  const ref = useRef(handlers)
  useEffect(() => {
    ref.current = handlers
  })
  useEffect(() => {
    if (!active) return
    const down = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      ref.current.onDown(e)
    }
    const up = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      ref.current.onUp?.(e)
    }
    const blur = () => ref.current.onBlur?.()
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
    }
  }, [active])
}

/** Typing targets where global shortcuts must not fire. With `numberIsShortcutSafe`, number inputs do not count. */
export function isTypingTarget(t: EventTarget | null, numberIsShortcutSafe = false): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true
  const safe = ['button', 'checkbox', 'radio', 'range', ...(numberIsShortcutSafe ? ['number'] : [])]
  return t instanceof HTMLInputElement && !safe.includes(t.type)
}
