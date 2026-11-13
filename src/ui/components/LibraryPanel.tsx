import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { keyById } from '../../device/layout'
import type { LayerId } from '../../device/types'
import type { Action, NamedAction } from '../../format/types'
import { describeAction, LAYER_ZH } from '../lib/describe'
import { compileAction, type Draft } from '../state/editor'
import {
  addToLibrary,
  duplicateEntry,
  findEntry,
  groupForAction,
  groupLabel,
  LIBRARY_GROUPS,
  libraryCount,
  libraryEntries,
  NAME_MAX,
  removeEntry,
  renameEntry,
  usages,
  validateName,
  type EntryRef,
  type KeyUsage,
  type LibraryGroup,
} from '../state/library'
import { Icon } from './Icon'
import './library.css'

export interface LibraryPanelProps {
  draft: Draft
  /** A library edit: the new draft and an undo label ("动作库：…"). */
  onChange: (draft: Draft, label: string) => void
  /** 用到当前键: assign this action (a fresh copy of the entry's) to the selected key. */
  onApply: (action: Action, entry: NamedAction) => void
  /** The selected key's action; undefined or null when no key is selected (applying is then disabled). */
  selectedAction?: Action | null
  /** Where the selected key is, e.g. "基础层 · Caps" (button hints). */
  selectedLabel?: string
  /** When given, the keys listed under "用于 N 个键" become buttons that select that key. */
  onSelectKey?: (layer: LayerId, keyId: string) => void
}

const usageLabel = (u: KeyUsage) => `${LAYER_ZH[u.layer]} · ${keyById(u.keyId)?.label ?? u.keyId}`

interface RowProps {
  entry: NamedAction
  entryRef: EntryRef
  draft: Draft
  current: boolean
  canApply: boolean
  applyHint: string
  onChange: LibraryPanelProps['onChange']
  onApply: LibraryPanelProps['onApply']
  onSelectKey?: LibraryPanelProps['onSelectKey']
  /** Called after 删除, so focus does not fall back to the page. */
  onRemoved: () => void
}

function LibraryRow({ entry, entryRef, draft, current, canApply, applyHint, onChange, onApply, onSelectKey, onRemoved }: RowProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const renameBtn = useRef<HTMLButtonElement>(null)
  /** Set by Enter / Escape in the name field: focus goes back to 重命名 once the field is gone. */
  const refocus = useRef(false)
  useEffect(() => {
    if (editing === null && refocus.current) {
      refocus.current = false
      renameBtn.current?.focus()
    }
  }, [editing])
  const errorId = useId()
  const used = useMemo(() => usages(draft, entry), [draft, entry])
  const error = editing === null ? null : validateName(draft, entryRef.group, editing, entryRef.index)

  const commit = () => {
    if (editing === null) return
    const name = editing.trim()
    setEditing(null)
    if (error || name === entry.name) return
    onChange(renameEntry(draft, entryRef, name), `动作库：重命名“${entry.name}”为“${name}”`)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (error) return
      refocus.current = true
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      refocus.current = true
      setEditing(null)
    }
  }

  return (
    <li className={`lib-item${current ? ' is-current' : ''}`}>
      <div className="lib-main">
        <div className="lib-title">
          {editing !== null ? (
            <input
              className={`lib-rename${error ? ' is-bad' : ''}`}
              value={editing}
              maxLength={NAME_MAX + 10}
              aria-label={`“${entry.name}”的新名称`}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              autoFocus
              onChange={(e) => setEditing(e.target.value)}
              onKeyDown={onKey}
              onBlur={commit}
            />
          ) : (
            <span className="lib-name">{entry.name}</span>
          )}
          {current && <span className="badge badge-ink">当前键</span>}
        </div>
        {error && (
          <p className="lib-error" id={errorId} role="alert">
            {error}
          </p>
        )}
        <p className="lib-sum">{describeAction(entry.action)}</p>
        {used.length === 0 ? (
          <p className="lib-use">还没有键使用</p>
        ) : (
          <details className="lib-use">
            <summary>用于 {used.length} 个键</summary>
            <ul>
              {used.map((u) => (
                <li key={`${u.layer}/${u.keyId}`}>
                  {onSelectKey ? (
                    <button type="button" className="link-btn" onClick={() => onSelectKey(u.layer, u.keyId)}>
                      {usageLabel(u)}
                    </button>
                  ) : (
                    usageLabel(u)
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="lib-tools">
        <button
          type="button"
          className="btn btn-sm"
          disabled={!canApply}
          title={applyHint}
          aria-label={`把“${entry.name}”用到当前键`}
          onClick={() => onApply(structuredClone(entry.action), entry)}
        >
          用到当前键
        </button>
        <button type="button" ref={renameBtn} className="btn btn-sm btn-ghost" aria-label={`重命名“${entry.name}”`} onClick={() => setEditing(entry.name)}>
          重命名
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={`复制“${entry.name}”`}
          title="复制一份"
          onClick={() => onChange(duplicateEntry(draft, entryRef).draft, `动作库：复制“${entry.name}”`)}
        >
          <Icon name="copy" />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={`删除“${entry.name}”`}
          title={used.length ? '删除（已使用它的键保持不变；可按 Ctrl+Z 撤销）' : '删除（可按 Ctrl+Z 撤销）'}
          onClick={() => {
            onChange(removeEntry(draft, entryRef), `动作库：删除“${entry.name}”`)
            onRemoved()
          }}
        >
          <Icon name="trash" />
        </button>
      </div>
    </li>
  )
}

/** 动作库: named combos / macros / emulates kept with the 方案 (KB84 预定义列表) for reuse on several keys. */
export function LibraryPanel({ draft, onChange, onApply, selectedAction, selectedLabel, onSelectKey }: LibraryPanelProps) {
  const titleId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  const hasKey = selectedAction !== undefined && selectedAction !== null
  const newGroup = groupForAction(selectedAction)
  // An entry that does not compile would make the whole profile invalid (and block writing) until it is deleted.
  const valid = !!selectedAction && compileAction(selectedAction) !== null
  const current = findEntry(draft, selectedAction)
  const total = libraryCount(draft)
  const where = selectedLabel ? `“${selectedLabel}”` : '当前键'
  const applyHint = hasKey ? `替换${where}的动作（可撤销）` : '先在键盘图上选择一个键'
  const newHint = !hasKey
    ? '先选择一个设置了组合键、宏或连发的键'
    : !newGroup
      ? '只有组合键、宏和连发可以存入动作库'
      : !valid
        ? '先修正这个键的错误，再存入动作库'
        : current
        ? `动作库里已经有相同的${groupLabel(current.group)}“${libraryEntries(draft, current.group)[current.index].name}”`
        : `把${where}的${groupLabel(newGroup)}存入动作库`

  const addCurrent = () => {
    if (!selectedAction || !newGroup || !valid) return
    const { draft: next, ref } = addToLibrary(draft, selectedAction)
    onChange(next, `动作库：新建“${libraryEntries(next, ref.group)[ref.index].name}”`)
  }

  return (
    <section className="lib" aria-labelledby={titleId}>
      <header className="lib-head">
        <div>
          <h2 id={titleId} ref={title} tabIndex={-1}>动作库</h2>
          <p className="muted">{total ? `共 ${total} 项 · 随方案一起保存和导出，不写入键盘` : '随方案一起保存和导出，不写入键盘'}</p>
        </div>
        <button type="button" className="btn btn-sm" disabled={!newGroup || !valid} title={newHint} onClick={addCurrent}>
          <Icon name="plus" />
          存入动作库
        </button>
      </header>

      {total === 0 ? (
        <div className="lib-empty">
          <p>
            把常用的组合键、宏和连发起个名字存进<b>动作库</b>，以后可以用到任意键上。相当于 KB84 的预定义列表。
          </p>
          <ul>
            <li>先在键盘图上选一个键，把它设置成组合键、宏或连发；</li>
            <li>再点上方的“存入动作库”，就会以“{groupLabel('combos')}1”“{groupLabel('macros')}1”这样的名字存入；</li>
            <li>用到某个键时是复制一份，之后修改库里的条目不会改动已经设置好的键。</li>
          </ul>
        </div>
      ) : (
        LIBRARY_GROUPS.map((group: LibraryGroup) => {
          const list = libraryEntries(draft, group)
          return (
            <section key={group} className="lib-group" aria-label={groupLabel(group)}>
              <h3>
                {groupLabel(group)}
                <span className="lib-count">{list.length}</span>
              </h3>
              {list.length === 0 ? (
                <p className="lib-none">还没有{groupLabel(group)}</p>
              ) : (
                <ul className="lib-list">
                  {list.map((entry, index) => (
                    <LibraryRow
                      key={index}
                      entry={entry}
                      entryRef={{ group, index }}
                      draft={draft}
                      current={current?.group === group && current.index === index}
                      canApply={hasKey}
                      applyHint={applyHint}
                      onChange={onChange}
                      onApply={onApply}
                      onSelectKey={onSelectKey}
                      onRemoved={() => title.current?.focus()}
                    />
                  ))}
                </ul>
              )}
            </section>
          )
        })
      )}
    </section>
  )
}
