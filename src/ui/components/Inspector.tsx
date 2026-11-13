import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { resolveCodeRef } from '../../device/codes'
import { FACTORY, keyById } from '../../device/layout'
import type { LayerId } from '../../device/types'
import { canonicalRef, slotToAction } from '../../format/compile'
import type { Action, CodeRef, FormatIssue } from '../../format/types'
import { slotsEqual } from '../../protocol/codec'
import type { SlotTable } from '../../protocol/slots'
import { convertAction } from '../lib/convert'
import { ACTION_ZH, actionFace, describeAction, LAYER_ZH } from '../lib/describe'
import { issueMessageZh, issueTarget, subPathZh } from '../lib/issues'
import { compileAction, type Draft, type KeyStatus } from '../state/editor'
import { KeyEditor } from './editors/KeyEditor'
import { LibraryQuick } from './editors/LibraryQuick'
import { ComboEditor, EmulateEditor } from './editors/ComboEmulate'
import { MacroEditor } from './editors/MacroEditor'
import { RawView } from './editors/RawView'
import { Icon } from './Icon'
import { Segmented } from './Segmented'
import './Inspector.css'

const FN = 156
const PROGRAM_MODE = 159
const TYPES = ['none', 'key', 'combo', 'macro', 'emulate'] as const
const LAYERS = ['base', 'fn'] as const

/** One fixed line under the type control saying what the chosen type does. */
const TYPE_LEAD: Record<Action['type'], string> = {
  none: '这个键平时不做任何事。',
  key: '发送一个键：普通键、多媒体键、鼠标键或键盘功能。',
  combo: '同时按下 2–6 个键，例如 Ctrl + Shift + Esc。',
  macro: '按顺序自动执行一串按键，可以加停顿、可以重复。',
  emulate: '按住时快速反复发送 1–6 个键（KB84 中叫“模拟击键”）。',
  raw: '这个键位的设置无法识别，会原样保留并写回。要修改，请在上面选择其他类型。',
}
const FN_NONE_LEAD = '按住 Fn 再按这个键时没有反应。'

interface Props {
  layer: LayerId
  keyId: string
  action: Action
  otherAction: Action
  status: KeyStatus
  issues: FormatIssue[]
  device: SlotTable | null
  onChange: (action: Action, label: string, coalesce?: string) => void
  onMirrorFn: () => void
  /** Called from the 两层 rows; App remounts the inspector for the new layer. */
  onLayer: (layer: LayerId) => void
  /** Shows 存入动作库 / 从动作库选择 under the combo, macro and emulate editors (and the picker for other keys once the library has entries). */
  library?: { draft: Draft; onChange: (draft: Draft, label: string) => void }
}

const isCode = (a: Action, value: number) => a.type === 'key' && resolveCodeRef(a.code)?.value === value

/** How much of an action a type switch can carry over; a smaller result means something was dropped. */
function contentSize(a: Action): number {
  switch (a.type) {
    case 'none':
      return 0
    case 'key':
      return 1
    case 'combo':
    case 'emulate':
      return a.keys.length
    case 'macro':
      return a.steps.length
    case 'raw':
      // nothing converts out of an unrecognised slot
      return Infinity
  }
}

export function Inspector({ layer, keyId, action, otherAction, status, issues, device, onChange, onMirrorFn, onLayer, library }: Props) {
  const key = keyById(keyId)!
  const i = key.no - 1
  const other: LayerId = layer === 'base' ? 'fn' : 'base'
  const factory = slotToAction(FACTORY[layer][i])
  const onDevice = device ? slotToAction(device[layer][i]) : null
  const baseFactory = FACTORY.base[i]
  const fallback: CodeRef = baseFactory.kind === 'codes' && baseFactory.codes[0] ? canonicalRef(baseFactory.codes[0]) : 'KeyA'
  const where = `${LAYER_ZH[layer]} · ${key.label}`
  const idBase = useId()
  const root = useRef<HTMLDivElement>(null)
  const stateLine = useRef<HTMLDivElement>(null)
  /** The action a lossy type switch produced; the note shows while the key still holds exactly that action. */
  const [lossy, setLossy] = useState<Action | null>(null)

  const change = (a: Action, coalesce?: string) => {
    setLossy(null)
    onChange(a, `修改 ${where}`, coalesce && `${layer}/${keyId}/${coalesce}`)
  }
  const setType = (t: Action['type']) => {
    const next = convertAction(action, t, fallback)
    change(next)
    if (contentSize(next) < contentSize(action)) setLossy(next)
  }
  /** 改回…: the link disappears with the difference, so focus stays on the state line. */
  const revert = (a: Action, label: string) => {
    stateLine.current?.focus()
    setLossy(null)
    onChange(a, `${label} ${where}`)
  }
  /**
   * App remounts the inspector for the new layer, which would drop focus on <body>: commit the switch now, then focus
   * the checked row of the inspector that took this one's place.
   */
  const switchLayer = (l: LayerId) => {
    if (l === layer) return
    const host = root.current?.parentElement
    flushSync(() => onLayer(l))
    host?.querySelector<HTMLElement>('.insp-layers [aria-checked="true"]')?.focus()
  }
  const onRowKey = (e: KeyboardEvent) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
    e.preventDefault()
    switchLayer(other)
  }

  // The other layer's status, computed the same way as derive() in editor.ts.
  const otherSlot = compileAction(otherAction)
  const rowOf = (l: LayerId) =>
    l === layer
      ? { action, changed: status.changed, pending: status.pending }
      : {
          action: otherAction,
          changed: !otherSlot || !slotsEqual(otherSlot, FACTORY[other][i]),
          pending: device !== null && (!otherSlot || !slotsEqual(otherSlot, device[other][i])),
        }

  const factoryIsMode = isCode(factory, PROGRAM_MODE)
  const guard = factoryIsMode
    ? '这是切换办公/编程模式的键（按住 Fn+F12 约 2 秒）。在编程模式下改掉它，可能就切不回办公模式了。'
    : isCode(action, PROGRAM_MODE)
      ? '这是切换办公/编程模式的键（按住约 2 秒）。在编程模式下改掉它，可能就切不回办公模式了。'
      : layer === 'base' && isCode(factory, FN)
        ? '这是 Fn 键。基础层上没有 Fn 键就进不了 Fn 层。'
        : null

  const stepIssues = new Map<number, string[]>()
  const general: FormatIssue[] = []
  for (const issue of issues) {
    const m = /^\/steps\/(\d+)/.exec(issueTarget(issue.path)?.sub ?? '')
    if (m && action.type === 'macro') stepIssues.set(Number(m[1]), [...(stepIssues.get(Number(m[1])) ?? []), issueMessageZh(issue.message)])
    else general.push(issue)
  }

  return (
    <div className="insp" ref={root}>
      <header className="insp-head">
        <div className="insp-key">
          <span className={`insp-cap${status.changed ? ' is-changed' : ''}`} aria-hidden="true">
            {actionFace(action, key).main || '无'}
          </span>
          <h2 title={`第 ${key.no} 号键`}>{layer === 'fn' ? `Fn + ${key.label}` : key.label}</h2>
        </div>
      </header>

      <div role="radiogroup" aria-label="这个键的两层" className="insp-layers">
        {LAYERS.map((l) => {
          const s = rowOf(l)
          const desc = describeAction(s.action)
          const flags = [s.changed && '与出厂不同', s.pending && '未写入'].filter(Boolean).join('，')
          return (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={l === layer}
              aria-label={`${LAYER_ZH[l]}：${desc}${flags && `（${flags}）`}`}
              aria-describedby={`${idBase}-${l}`}
              tabIndex={l === layer ? 0 : -1}
              onClick={() => switchLayer(l)}
              onKeyDown={onRowKey}
            >
              <span className="insp-layer-name">{LAYER_ZH[l]}</span>
              <span className="insp-layer-act">{desc}</span>
              <span className="insp-layer-dots" aria-hidden="true">
                {s.changed && <span className="dot-changed" title="与出厂不同" />}
                {s.pending && <span className="dot-pending" title="未写入" />}
              </span>
              <span className="insp-layer-how" id={`${idBase}-${l}`}>
                {l === 'base' ? `按 ${key.label}` : `按住 Fn 再按 ${key.label}`}
              </span>
            </button>
          )
        })}
      </div>

      <div className="insp-state" ref={stateLine} tabIndex={-1}>
        {status.changed ? (
          <p>
            出厂是 {describeAction(factory)} ·{' '}
            <button type="button" className="link-btn" onClick={() => revert(factory, '改回出厂')}>
              改回出厂
            </button>
          </p>
        ) : (
          <p className="muted">出厂键位</p>
        )}
        {status.pending && onDevice && (
          <p>
            键盘里现在是 {describeAction(onDevice)} · <span className="badge badge-ink">未写入</span>{' '}
            <button type="button" className="link-btn" onClick={() => revert(onDevice, '改回键盘里的')}>
              改回键盘里的
            </button>
          </p>
        )}
      </div>

      {guard && (
        <p className="note note-warn">
          {guard}
          {factoryIsMode && status.changed && (
            <button type="button" className="btn btn-sm" onClick={() => revert(factory, '改回模式切换')}>
              <Icon name="restore" size={14} />改回模式切换
            </button>
          )}
        </p>
      )}

      <div className="field">
        <span className="field-label">动作类型</span>
        <Segmented<Action['type']>
          label="动作类型"
          block
          value={action.type}
          onChange={setType}
          options={[
            ...TYPES.map((t) => ({ value: t, label: ACTION_ZH[t] })),
            ...(action.type === 'raw' ? [{ value: 'raw' as const, label: ACTION_ZH.raw }] : []),
          ]}
        />
        {lossy === action && (
          <p className="muted insp-lost" role="status">
            切换类型丢掉了原来的内容，可按 Ctrl+Z 撤销。
          </p>
        )}
        <p className="lead insp-type-lead">{layer === 'fn' && action.type === 'none' ? FN_NONE_LEAD : TYPE_LEAD[action.type]}</p>
      </div>

      {action.type === 'key' && (
        <KeyEditor action={action} onChange={(a) => change(a)} otherLayerHasFn={isCode(otherAction, FN)} onMirrorFn={onMirrorFn} />
      )}
      {action.type === 'combo' && <ComboEditor action={action} onChange={change} />}
      {action.type === 'macro' && <MacroEditor action={action} onChange={change} stepIssues={stepIssues} />}
      {action.type === 'emulate' && <EmulateEditor action={action} onChange={change} />}
      {action.type === 'raw' && <RawView action={action} />}
      {library && action.type !== 'raw' && (
        <LibraryQuick
          draft={library.draft}
          action={action}
          where={where}
          onLibraryChange={library.onChange}
          onApply={(a, label) => {
            setLossy(null)
            onChange(a, label)
          }}
        />
      )}

      {general.length > 0 && (
        <ul className="insp-issues">
          {general.map((issue, j) => {
            const sub = subPathZh(issueTarget(issue.path)?.sub ?? '')
            return (
              <li key={j} className={`issue issue-${issue.severity}`}>
                <Icon name={issue.severity === 'error' ? 'error' : 'warn'} size={14} />
                <span>{sub && <b>{sub}：</b>}{issueMessageZh(issue.message)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
