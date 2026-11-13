import type { Action } from '../../../format/types'
import { NumberField } from '../NumberField'
import { CodeChips } from './CodeChips'

type Change = (a: Action, coalesce?: string) => void

export function ComboEditor({ action, onChange }: { action: Extract<Action, { type: 'combo' }>; onChange: Change }) {
  return (
    <div className="editor">
      <CodeChips codes={action.keys} min={2} max={6} captureLabel="用键盘录入组合键" onChange={(keys) => onChange({ type: 'combo', keys })} />
    </div>
  )
}

export function EmulateEditor({ action, onChange }: { action: Extract<Action, { type: 'emulate' }>; onChange: Change }) {
  return (
    <div className="editor">
      <CodeChips codes={action.keys} min={1} max={6} captureLabel="用键盘录入要连发的键" onChange={(keys) => onChange({ ...action, keys })} />
      <NumberField
        label="连发间隔"
        unit=""
        min={0}
        max={6000}
        value={action.interval}
        hint="数值越大越慢（单位未确认，可能是毫秒）。KB84 默认 30。"
        onChange={(interval) => onChange({ ...action, interval }, 'emulate-interval')}
      />
    </div>
  )
}
