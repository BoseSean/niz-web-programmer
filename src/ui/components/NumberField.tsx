import { useId, useState } from 'react'

interface Props {
  label: string
  value: number
  min: number
  max: number
  unit?: string
  hint?: string
  onChange: (v: number) => void
  compact?: boolean
}

/** Integer input that keeps the user's text while typing and commits every parseable value. */
export function NumberField({ label, value, min, max, unit = 'ms', hint, onChange, compact }: Props) {
  const id = useId()
  const [text, setText] = useState(String(value))
  const [shown, setShown] = useState(value)
  // Follow outside changes (undo, other editors) without clobbering what is being typed.
  if (shown !== value) {
    setShown(value)
    if (Number(text) !== value) setText(String(value))
  }
  const n = Number(text)
  const bad = text === '' || !Number.isInteger(n) || n < min || n > max
  return (
    <div className={`field${compact ? ' field-compact' : ''}`}>
      {!compact && <label htmlFor={id}>{label}</label>}
      <div className={`num${bad ? ' is-bad' : ''}`}>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={text}
          aria-label={compact ? label : undefined}
          aria-invalid={bad}
          onChange={(e) => {
            setText(e.target.value)
            const v = Number(e.target.value)
            if (e.target.value !== '' && Number.isInteger(v)) {
              setShown(v)
              onChange(v)
            }
          }}
        />
        {unit && <span className="num-unit">{unit}</span>}
      </div>
      {hint && !compact && <span className="field-hint">{hint}</span>}
    </div>
  )
}
