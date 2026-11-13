import { useRef, useState } from 'react'
import { codeForKeyboardEventCode, codeShort } from '../../../device/codes'
import type { CodeRef } from '../../../format/types'
import { codeZh } from '../../lib/describe'
import { useKeyCapture } from '../../lib/useKeyCapture'
import { CodePicker } from '../CodePicker'
import { Icon } from '../Icon'

const MODIFIERS: [('ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'), string[]][] = [
  ['ctrlKey', ['ControlLeft', 'ControlRight']],
  ['shiftKey', ['ShiftLeft', 'ShiftRight']],
  ['altKey', ['AltLeft', 'AltRight']],
  ['metaKey', ['MetaLeft', 'MetaRight']],
]

interface Props {
  codes: CodeRef[]
  /** Fewest keys the action needs; below it the count reads "还差 n 个键". */
  min?: number
  max: number
  onChange: (codes: CodeRef[]) => void
  /** Label of the chord-capture button; capture is off when omitted. */
  captureLabel?: string
}

/** Up to `max` code chips with remove, add-from-picker and "press a chord" capture. */
export function CodeChips({ codes, min, max, onChange, captureLabel }: Props) {
  const [picking, setPicking] = useState(false)
  const [capturing, setCapturing] = useState(false)
  // Several key events can arrive before React re-renders, so the chord being captured lives in a ref.
  const [chord, setChordState] = useState<CodeRef[]>([])
  const chordRef = useRef<CodeRef[]>([])
  const setChord = (next: CodeRef[]) => {
    chordRef.current = next
    setChordState(next)
  }
  const [held] = useState(() => new Set<string>())
  const full = codes.length >= max

  useKeyCapture(capturing, {
    onDown: (e) => {
      if (e.repeat) return
      const info = codeForKeyboardEventCode(e.code)
      held.add(e.code)
      const chord = chordRef.current
      // Modifier flags also count, in case the modifier's own keydown never reached the page.
      const own = info && !chord.includes(info.id) ? [info.id] : []
      const have = [...chord, ...own]
      const mods = MODIFIERS.filter(([flag, ids]) => e[flag] && !ids.some((id) => have.includes(id))).map(([, ids]) => ids[0])
      const next = [...chord, ...mods, ...own]
      if (next.length !== chord.length) setChord(next.slice(0, max))
    },
    onUp: (e) => {
      held.delete(e.code)
      const chord = chordRef.current
      if (held.size === 0 && chord.length > 0) {
        onChange(chord)
        setChord([])
        setCapturing(false)
      }
    },
    onBlur: () => {
      held.clear()
      setChord([])
      setCapturing(false)
    },
  })

  return (
    <div className="chips-box">
      <ul className="chips" aria-label="按键列表">
        {(capturing ? chord : codes).map((c, i) => (
          <li key={`${c}-${i}`} className="chip" title={codeZh(c)}>
            <span className="mono">{codeShort(c)}</span>
            <span className="chip-name">{codeZh(c)}</span>
            {!capturing && (
              <button type="button" aria-label={`移除 ${codeZh(c)}`} onClick={() => onChange(codes.filter((_, j) => j !== i))}>
                <Icon name="x" size={12} />
              </button>
            )}
          </li>
        ))}
        {!capturing && codes.length === 0 && <li className="chips-empty">还没有按键</li>}
        {capturing && chord.length === 0 && <li className="chips-empty">请同时按下这些键，全部松开后完成…</li>}
      </ul>
      <div className="row-actions">
        <button type="button" className="btn btn-sm" disabled={full || capturing} onClick={() => setPicking(!picking)} aria-expanded={picking}>
          <Icon name="plus" size={14} />
          {picking ? '收起列表' : '从列表添加'}
        </button>
        {captureLabel && (
          <button
            type="button"
            className={`btn btn-sm btn-capture${capturing ? ' is-live' : ''}`}
            onClick={() => {
              held.clear()
              setChord([])
              setCapturing(!capturing)
              setPicking(false)
            }}
            aria-pressed={capturing}
          >
            <Icon name="keyboard" size={14} />
            {capturing ? '取消' : captureLabel}
          </button>
        )}
        <span className="muted">{min !== undefined && codes.length < min ? `还差 ${min - codes.length} 个键` : `${codes.length} / ${max}`}</span>
      </div>
      {picking && !full && (
        <CodePicker
          inList
          autoFocus
          onPick={(c) => {
            const next = [...codes, c]
            onChange(next)
            if (next.length >= max) setPicking(false)
          }}
        />
      )}
    </div>
  )
}
