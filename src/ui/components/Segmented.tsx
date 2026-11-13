import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  hint?: string
  disabled?: boolean
}

interface Props<T extends string> {
  value: T
  options: readonly SegmentOption<T>[]
  onChange: (v: T) => void
  label: string
  size?: 'sm' | 'md'
  /** Stretch to the container width with equal segments. */
  block?: boolean
  /**
   * What the arrow keys do. 'manual' (default): they only move focus, Space / Enter selects, so arrowing past an
   * option whose selection converts or drops something (动作类型, 按键之间) does not run it. 'auto': they also select.
   */
  activation?: 'auto' | 'manual'
}

const STEP: Partial<Record<string, 1 | -1>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/** A radiogroup with one tab stop (the checked option); ← → ↑ ↓ wrap, Home End jump, disabled options are skipped. */
export function Segmented<T extends string>({ value, options, onChange, label, size = 'md', block, activation = 'manual' }: Props<T>) {
  const group = useRef<HTMLDivElement>(null)
  // The checked option holds the tab stop; the first enabled one when it cannot take focus (disabled, or no match).
  const stop = options.find((o) => o.value === value && !o.disabled) ?? options.find((o) => !o.disabled)

  const onKey = (e: KeyboardEvent, i: number) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return // Alt+← is the browser's Back
    const enabled = options.flatMap((o, j) => (o.disabled ? [] : [j]))
    const step = STEP[e.key]
    let to: number | undefined
    if (e.key === 'Home') to = enabled[0]
    else if (e.key === 'End') to = enabled.at(-1)
    else if (step) to = enabled[(enabled.indexOf(i) + step + enabled.length) % enabled.length]
    if (to === undefined) return
    e.preventDefault()
    group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus()
    if (activation === 'auto' && options[to].value !== value) onChange(options[to].value)
  }

  return (
    <div className={`seg seg-${size}${block ? ' seg-block' : ''}`} role="radiogroup" aria-label={label} ref={group}>
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'is-on' : undefined}
          disabled={o.disabled}
          title={o.hint}
          tabIndex={o === stop ? 0 : -1}
          onClick={() => o.value !== value && onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
