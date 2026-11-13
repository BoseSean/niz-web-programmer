import { useId, useRef, useState, type KeyboardEvent } from 'react'
import type { Action, NamedAction } from '../../../format/types'
import { describeAction } from '../../lib/describe'
import { compileAction, type Draft } from '../../state/editor'
import {
  addToLibrary,
  findEntry,
  GROUP_OF,
  groupLabel,
  isLibraryAction,
  LIBRARY_GROUPS,
  libraryEntries,
  type EntryRef,
} from '../../state/library'
import { Icon } from '../Icon'

interface Props {
  draft: Draft
  /** The key's action. Combo / macro / emulate get 存入动作库 and a picker of their own group; others a picker of all groups. */
  action: Action
  /** Where the key is ("基础层 · Caps Lock"), for undo labels. */
  where: string
  /** A library edit (undoable). */
  onLibraryChange: (draft: Draft, label: string) => void
  /** Replace the key's action with a copy of a library entry (undoable). */
  onApply: (action: Action, label: string) => void
}

/** 存入动作库 / 从动作库选择 in the key inspector (under the combo, macro and emulate editors). */
export function LibraryQuick({ draft, action, where, onLibraryChange, onApply }: Props) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const own = isLibraryAction(action) ? GROUP_OF[action.type] : null
  const groups = own ? [own] : LIBRARY_GROUPS
  const entries = groups.flatMap((group) => libraryEntries(draft, group).map((entry, index) => ({ entry, ref: { group, index } as EntryRef })))
  const same = findEntry(draft, action)
  const sameName = same ? libraryEntries(draft, same.group)[same.index]?.name : null
  const valid = compileAction(action) !== null
  const what = own ? groupLabel(own) : '组合键、宏或连发'

  if (!own && entries.length === 0) return null

  const save = () => {
    const { draft: next, ref } = addToLibrary(draft, action)
    onLibraryChange(next, `动作库：新建“${libraryEntries(next, ref.group)[ref.index].name}”`)
  }
  const pick = (entry: NamedAction) => {
    setOpen(false)
    toggle.current?.focus()
    onApply(structuredClone(entry.action), `把“${entry.name}”用到 ${where}`)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation()
      setOpen(false)
      toggle.current?.focus()
    }
  }

  return (
    <div className="lib-quick" onKeyDown={onKey}>
      <div className="lib-quick-tools">
        {own && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={!!same || !valid}
            title={same ? `动作库里已经有相同的${what}“${sameName}”` : !valid ? '先修正这个键的错误' : `以“${what}N”的名字存入动作库，之后可以用到其他键`}
            onClick={save}
          >
            <Icon name="plus" size={14} />
            存入动作库
          </button>
        )}
        <button
          type="button"
          ref={toggle}
          className="btn btn-sm"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          disabled={entries.length === 0}
          title={entries.length ? `从动作库的${what}里选一个用到当前键（替换现在的动作）` : `动作库里还没有${what}`}
          onClick={() => setOpen(!open)}
        >
          <Icon name="book" size={14} />
          从动作库选择
          {entries.length > 0 && <span className="lib-count" aria-hidden="true">{entries.length}</span>}
        </button>
      </div>
      {sameName && <p className="lib-quick-note muted">与动作库中的“{sameName}”相同</p>}
      {open && (
        <ul className="lib-quick-list" id={listId} aria-label={`动作库中的${what}`}>
          {entries.map(({ entry, ref }, i) => {
            const current = same?.group === ref.group && same.index === ref.index
            return (
              <li key={`${ref.group}/${ref.index}:${entry.name}`}>
                <button type="button" autoFocus={i === 0} onClick={() => pick(entry)} aria-current={current ? 'true' : undefined} title="用到当前键">
                  <span className="lib-quick-name">{entry.name}</span>
                  {/* macros and emulates already read "宏：…" / "连发 …"; a combo is just its keys */}
                  <small>{!own && ref.group === 'combos' ? `${groupLabel(ref.group)} · ` : ''}{describeAction(entry.action)}</small>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
