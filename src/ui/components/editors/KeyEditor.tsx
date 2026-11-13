import { useId, useState } from 'react'
import { codeForKeyboardEventCode, resolveCodeRef } from '../../../device/codes'
import type { Action, CodeRef } from '../../../format/types'
import { codeZh } from '../../lib/describe'
import { useKeyCapture } from '../../lib/useKeyCapture'
import { CodeNote, CodePicker } from '../CodePicker'
import { Icon } from '../Icon'

const FN = 156

/** "改成我按下的键": maps the next physical key press to a code. */
export function CaptureButton({ onCapture, label = '改成我按下的键', hint }: { onCapture: (ref: CodeRef) => void; label?: string; hint?: string }) {
  const [active, setActive] = useState(false)
  const [miss, setMiss] = useState<string | null>(null)
  const hintId = useId()
  useKeyCapture(active, {
    onDown: (e) => {
      if (e.repeat) return
      const info = codeForKeyboardEventCode(e.code)
      if (!info) return setMiss(e.code || e.key)
      setMiss(null)
      setActive(false)
      onCapture(info.id)
    },
    onBlur: () => setActive(false),
  })
  return (
    <div className="capture">
      <button
        type="button"
        className={`btn btn-capture${active ? ' is-live' : ''}`}
        onClick={() => {
          setMiss(null)
          setActive(!active)
        }}
        aria-pressed={active}
        aria-describedby={hint ? hintId : undefined}
      >
        <Icon name="keyboard" />
        {active ? '请按下想要的键…（点此取消）' : label}
      </button>
      {active && miss && <span className="capture-miss">“{miss}” 不能录入，请换一个键，或在下面的列表里选</span>}
      {hint && (
        <span className="muted capture-hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  )
}

interface Props {
  action: Extract<Action, { type: 'key' }>
  onChange: (a: Action) => void
  /** Fn must sit on both layers of the same key; offers to fix the other layer. */
  otherLayerHasFn: boolean
  onMirrorFn: () => void
}

export function KeyEditor({ action, onChange, otherLayerHasFn, onMirrorFn }: Props) {
  const r = resolveCodeRef(action.code)
  const isFn = r?.value === FN
  // The code's id and number are protocol details: kept in the card's tooltip only.
  const detail = [typeof action.code === 'string' && action.code, r && `0x${r.value.toString(16).toUpperCase().padStart(2, '0')}`].filter(Boolean).join(' · ')
  return (
    <div className="editor">
      <div className="current-code" title={detail || undefined}>
        <span className="current-cap mono">{r?.info?.short ?? action.code}</span>
        <div>
          <span className="field-label">现在是</span>
          <strong>{codeZh(action.code)}</strong>
        </div>
      </div>
      <CaptureButton
        onCapture={(code) => onChange({ type: 'key', code })}
        hint="只能录入普通键和多媒体键；鼠标、Fn 等请在下面的列表里选。"
      />
      <CodeNote code={action.code} />
      {isFn && !otherLayerHasFn && (
        <div className="note note-warn">
          Fn 需要在同一个键的两层都设置，否则切换层时会出错。
          <button type="button" className="btn btn-sm" onClick={onMirrorFn}>同时设置到另一层</button>
        </div>
      )}
      <CodePicker value={action.code} onPick={(code) => onChange({ type: 'key', code })} />
    </div>
  )
}
