import { useState } from 'react'
import { CODES, resolveCodeRef } from '../../device/codes'
import type { CodeCategory, CodeInfo } from '../../device/types'
import type { CodeRef } from '../../format/types'
import { CATEGORY_ZH, isNoEffect, isUncertain, noteZh } from '../lib/describe'
import { Icon } from './Icon'
import './CodePicker.css'

const DOUBLE_CLICK = 199
const CATEGORIES = Object.keys(CATEGORY_ZH) as CodeCategory[]

interface Props {
  value?: CodeRef | null
  onPick: (ref: CodeRef) => void
  /** For combos, macros and emulates: hides codes that only work as a single key (double click). */
  inList?: boolean
  autoFocus?: boolean
}

const hex = (v: number) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`

function matches(c: CodeInfo, q: string): boolean {
  if (!q) return true
  const hay = [c.zh, c.en, c.id, c.short, String(c.value), hex(c.value)].join(' ').toLowerCase()
  return q.split(/\s+/).every((part) => hay.includes(part))
}

/**
 * Searchable code list grouped by category (键盘 / 多媒体 / 鼠标 / 键盘功能 / 电源 / 未知功能). Codes that do nothing on
 * the 84EC-S or whose effect is unverified are hidden until asked for; a search still finds them, and the current
 * value is always listed.
 */
export function CodePicker({ value, onPick, inList, autoFocus }: Props) {
  const [query, setQuery] = useState('')
  const [cat, setCat] = useState<CodeCategory | 'all'>('all')
  const [showAll, setShowAll] = useState(false)
  const selected = value === null || value === undefined ? undefined : resolveCodeRef(value)?.value
  const q = query.trim().toLowerCase()

  const offered = CODES.filter((c) => !(inList && c.value === DOUBLE_CLICK))
  // Hidden until 显示… is clicked or a search finds them: codes with no effect here or an unverified one (isUncertain).
  const listed = (c: CodeInfo) => showAll || c.value === selected || !isUncertain(c)
  // A category whose codes are all hidden loses its tab (未知功能, unless the current value is one of them).
  const cats = CATEGORIES.filter((id) => offered.some((c) => c.category === id && listed(c)))
  const activeCat = cat === 'all' || cats.includes(cat) ? cat : 'all'
  const inCat = offered.filter((c) => activeCat === 'all' || c.category === activeCat)
  // A search also finds hidden codes (the key tester's guide has people search 0xA2), shown with their badge.
  const list = inCat.filter((c) => (q ? matches(c, q) : listed(c)))
  const hideable = q ? 0 : inCat.filter((c) => isUncertain(c) && c.value !== selected).length
  const groups = CATEGORIES.map((id) => ({ id, codes: list.filter((c) => c.category === id) })).filter((g) => g.codes.length)
  // Enter takes the first option shown, preferring one that works on this keyboard.
  const shown = groups.flatMap((g) => g.codes)
  const first = shown.find((c) => !isUncertain(c)) ?? shown[0]

  return (
    <div className="picker">
      <div className="picker-search">
        <Icon name="search" />
        <input
          type="search"
          placeholder="搜索：名称、英文或代码，如 音量、Esc、0xA2"
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && first) {
              e.preventDefault()
              onPick(first.id)
            }
          }}
          aria-label="搜索按键代码"
        />
      </div>
      <div className="picker-cats" role="tablist" aria-label="代码分类">
        {(['all', ...cats] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeCat === id}
            className={activeCat === id ? 'is-on' : undefined}
            onClick={() => setCat(id)}
          >
            {id === 'all' ? '全部' : CATEGORY_ZH[id]}
          </button>
        ))}
      </div>
      <div className="picker-list" role="listbox" aria-label="可选代码">
        {groups.length === 0 && <p className="picker-empty">没有找到“{query}”</p>}
        {groups.map((g) => (
          <section key={g.id}>
            {(activeCat === 'all' || q) && <h4>{CATEGORY_ZH[g.id]}</h4>}
            <div className="picker-grid">
              {g.codes.map((c) => {
                const note = noteZh(c.note)
                const noEffect = isNoEffect(c)
                const unsure = isUncertain(c)
                return (
                  <button
                    key={c.value}
                    type="button"
                    role="option"
                    aria-selected={c.value === selected}
                    className={`picker-opt${c.value === selected ? ' is-on' : ''}${unsure ? ' is-uncertain' : ''}`}
                    title={[`${c.zh} · ${c.en} · ${hex(c.value)}`, note].filter(Boolean).join('\n')}
                    onClick={() => onPick(c.id)}
                  >
                    <span className="picker-cap">{c.short}</span>
                    <span className="picker-text">
                      <span className="picker-name">{c.zh}</span>
                      {unsure && <span className="picker-sub">{noEffect ? '84EC-S 没有背光，按下无效果' : '在 84EC-S 上的作用未验证'}</span>}
                    </span>
                    {unsure && <span className={`picker-badge${noEffect ? ' is-wide' : ''}`} aria-hidden="true">{noEffect ? '无效' : '?'}</span>}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </div>
      {hideable > 0 && (
        <div className="picker-more">
          <button type="button" className="link-btn" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
            {showAll ? '隐藏无效或作用未知的代码' : `显示 ${hideable} 个无效或作用未知的代码（背光、未知功能等）`}
          </button>
        </div>
      )}
    </div>
  )
}

/** Explanation block for one code (notes, uncertainty). */
export function CodeNote({ code }: { code: CodeRef }) {
  const r = resolveCodeRef(code)
  if (!r) return null
  const info = r.info
  const note = noteZh(info?.note)
  if (!info) return <p className="note note-warn">代码 {hex(r.value)} 不是已知的设备代码，会原样发送给键盘。</p>
  if (!note && !isUncertain(info)) return null
  return <p className={`note${isUncertain(info) ? ' note-warn' : ''}`}>{note ?? '这个代码在 84EC-S 上的作用尚未验证。'}</p>
}
