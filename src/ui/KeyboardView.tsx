import type { CSSProperties, KeyboardEvent } from 'react'
import { BOARD_HEIGHT_U, BOARD_WIDTH_U } from '../device/layout'
import type { KeyInfo } from '../device/types'
import './KeyboardView.css'

export interface KeyFace {
  /** Big text: what the key does on the current layer */
  main: string
  /** Small text: the physical legend, shown when it differs from `main` */
  legend?: string
  /** Short tag for non-plain actions, e.g. "宏", "组合", "媒体" */
  tag?: string
  /** Base layer: what the key does while Fn is held, in small text in the cap's bottom-right corner */
  fn?: string
  /** Tooltip; by default "legend → main" */
  title?: string
  /** True when the action differs from the factory default of this layer */
  changed?: boolean
  /** True when the slot is empty / transparent */
  empty?: boolean
  /** True when the edit is not on the keyboard yet (differs from the last read) */
  pending?: boolean
  /** True when the action has validation errors */
  invalid?: boolean
  /** Accessible description of the key's state */
  description?: string
}

interface Props {
  keys: readonly KeyInfo[]
  faces: Record<string, KeyFace>
  selected?: string | null
  pressed?: ReadonlySet<string>
  /** A click selects a key; Esc on the board clears the selection with null. */
  onSelect?: (id: string | null) => void
  /** Accessible name of the key grid. */
  label?: string
  /** Fn-layer view: empty keys show no "·" and fade, so the keys that do something stand out. */
  dimEmpty?: boolean
  /** A key drawn held down, e.g. "fn" while the Fn layer is shown. */
  heldKeyId?: string
  /** Text on the case below the keys, e.g. the layer shown; by default the model name. */
  caseLabel?: string
}

export function KeyboardView({
  keys,
  faces,
  selected,
  pressed,
  onSelect,
  label = '84EC-S 键位',
  dimEmpty,
  heldKeyId,
  caseLabel = 'NIZ · PLUM 84EC-S',
}: Props) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || !onSelect || !selected) return
    e.preventDefault()
    onSelect(null)
  }
  return (
    <div
      className={`kb-case${dimEmpty ? ' dim-empty' : ''}`}
      style={{ '--cols': BOARD_WIDTH_U, '--rows': BOARD_HEIGHT_U } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <div className="kb-plate" role="group" aria-label={label}>
        {keys.map((k, i) => {
          const face = faces[k.id] ?? { main: k.label }
          const cls = [
            'kb-key',
            face.changed && 'is-changed',
            face.empty && 'is-empty',
            face.pending && 'is-pending',
            face.invalid && 'is-invalid',
            face.tag && 'has-tag',
            face.fn && 'has-fn',
            selected === k.id && 'is-selected',
            pressed?.has(k.id) && 'is-pressed',
            heldKeyId === k.id && 'is-held',
            k.w >= 1.75 && 'is-wide',
          ].filter(Boolean).join(' ')
          const main = face.empty ? '' : face.main
          const legend = face.legend && face.legend !== main ? face.legend : undefined
          // CJK characters and symbols such as ⇄ are about twice as wide as Latin letters.
          const chars = [...main].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2000 ? 1.8 : 1), 0)
          return (
            <button
              key={k.id}
              type="button"
              className={cls}
              style={{ '--x': k.x, '--y': k.y, '--w': k.w, '--i': i, '--chars': Math.max(3, chars) } as CSSProperties}
              onClick={() => onSelect?.(k.id)}
              aria-pressed={selected === k.id}
              aria-label={`${k.label}：${face.empty ? '无' : face.main}${face.description ? `（${face.description}）` : ''}`}
              title={face.title ?? (legend ? `${legend} → ${face.empty ? '无' : main}` : main || '无')}
            >
              <span className="kb-cap">
                {legend && <span className="kb-legend">{legend}</span>}
                <span className="kb-main">{main || (dimEmpty && face.empty ? '' : '·')}</span>
                {face.tag && <span className="kb-tag">{face.tag}</span>}
                {face.fn && <span className="kb-fn">{face.fn}</span>}
              </span>
            </button>
          )
        })}
      </div>
      <span className="kb-badge" aria-hidden="true">{caseLabel}</span>
    </div>
  )
}
