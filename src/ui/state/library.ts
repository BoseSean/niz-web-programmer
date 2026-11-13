/**
 * 动作库 (KB84 "Predefined" lists): pure operations on the `library` field of the editor draft.
 *
 * The library holds named combo / macro / emulate templates. Applying an entry copies its action onto a key; there is
 * no reference between the key and the entry (docs/FORMAT.md §8.2). Every operation returns a new draft and never
 * mutates its input. Groups that become empty are removed, and so is the whole `library` once nothing is left, so a
 * draft without library entries serializes exactly like one that never had any.
 */
import { resolveCodeRef } from '../../device/codes'
import { KEYS } from '../../device/layout'
import { LAYERS, type LayerId } from '../../device/types'
import type { Action, NamedAction } from '../../format/types'
import type { Draft } from './editor'

export type LibraryGroup = 'combos' | 'macros' | 'emulates'
export type LibraryAction = Extract<Action, { type: 'combo' | 'macro' | 'emulate' }>
export type Library = NonNullable<Draft['library']>

export const LIBRARY_GROUPS: readonly LibraryGroup[] = ['combos', 'macros', 'emulates']

/** The library group that holds each action type. */
export const GROUP_OF: Record<LibraryAction['type'], LibraryGroup> = { combo: 'combos', macro: 'macros', emulate: 'emulates' }

/** The action type each library group holds (inverse of GROUP_OF). */
export const GROUP_TYPE: Record<LibraryGroup, LibraryAction['type']> = { combos: 'combo', macros: 'macro', emulates: 'emulate' }

/** Display names of the groups, which are also the prefixes of new automatic names (组合键1, 宏1, 连发1). */
export const GROUP_LABEL: Record<LibraryAction['type'], string> = { combo: '组合键', macro: '宏', emulate: '连发' }

/** GROUP_LABEL by group: "组合键" / "宏" / "连发". */
export const groupLabel = (group: LibraryGroup): string => GROUP_LABEL[GROUP_TYPE[group]]

/**
 * KB84's own auto-name prefixes (组合键1, 宏定义1, 模拟击键1), for code that deals with names in .pro files. New entries
 * are named with GROUP_LABEL; names already in a file are never renamed.
 */
export const GROUP_ZH: Record<LibraryGroup, string> = { combos: '组合键', macros: '宏定义', emulates: '模拟击键' }

/** Longest entry name accepted by renameEntry / addToLibrary. */
export const NAME_MAX = 40

/** Position of one entry: its group and index in that group. */
export interface EntryRef {
  group: LibraryGroup
  index: number
}

export interface KeyUsage {
  layer: LayerId
  keyId: string
}

export class LibraryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LibraryError'
  }
}

export function isLibraryAction(a: Action | null | undefined): a is LibraryAction {
  return a?.type === 'combo' || a?.type === 'macro' || a?.type === 'emulate'
}

/** The group an action belongs to, or null for actions the library cannot hold (none, key, raw). */
export function groupForAction(a: Action | null | undefined): LibraryGroup | null {
  return isLibraryAction(a) ? GROUP_OF[a.type] : null
}

export function libraryEntries(draft: Draft, group: LibraryGroup): readonly NamedAction[] {
  return draft.library?.[group] ?? []
}

export function entryAt(draft: Draft, ref: EntryRef): NamedAction | undefined {
  return Number.isInteger(ref.index) && ref.index >= 0 ? libraryEntries(draft, ref.group)[ref.index] : undefined
}

export function libraryCount(draft: Draft): number {
  return LIBRARY_GROUPS.reduce((n, g) => n + libraryEntries(draft, g).length, 0)
}

const clone = <T>(v: T): T => structuredClone(v)

/** Replaces one group, pruning empty groups and an empty library. */
function withGroup(draft: Draft, group: LibraryGroup, list: NamedAction[]): Draft {
  const library: Library = { ...draft.library }
  if (list.length) library[group] = list
  else delete library[group]
  const next: Draft = { ...draft, library }
  if (!LIBRARY_GROUPS.some((g) => library[g]?.length)) delete next.library
  return next
}

function mustGet(draft: Draft, ref: EntryRef): NamedAction {
  const entry = entryAt(draft, ref)
  if (!entry) throw new LibraryError(`动作库里没有第 ${ref.index + 1} 项${groupLabel(ref.group)}`)
  return entry
}

/**
 * Why a name cannot be used for an entry of `group` (Chinese message), or null when it can. `except` is the index of
 * the entry being renamed (its own name does not count as taken). Names are trimmed first.
 */
export function validateName(draft: Draft, group: LibraryGroup, name: string, except?: number): string | null {
  const n = name.trim()
  if (!n) return '名称不能为空'
  if (n.length > NAME_MAX) return `名称最多 ${NAME_MAX} 个字符`
  // XML attributes in .pro files turn control characters (newlines, tabs) into spaces.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(n)) return '名称不能包含换行等控制字符'
  if (libraryEntries(draft, group).some((e, i) => i !== except && e.name === n)) return `已经有一个叫“${n}”的${groupLabel(group)}`
  return null
}

/** `base` itself if free, else "base 2", "base 3", … */
function uniqueName(draft: Draft, group: LibraryGroup, base: string): string {
  const taken = new Set(libraryEntries(draft, group).map((e) => e.name))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`
}

/** The next automatic name, KB84 style: 组合键N / 宏N / 连发N, N = entry count + 1 (skipping taken names). */
export function nextAutoName(draft: Draft, group: LibraryGroup): string {
  const taken = new Set(libraryEntries(draft, group).map((e) => e.name))
  const prefix = groupLabel(group)
  for (let n = libraryEntries(draft, group).length + 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`
}

/**
 * Appends a copy of `action` to the group of its type. Without `name` the entry gets the next automatic name; a
 * given name is trimmed and made unique ("名称 2"). Throws LibraryError for actions the library cannot hold and for
 * names validateName rejects for reasons other than being taken.
 */
export function addToLibrary(draft: Draft, action: Action, name?: string): { draft: Draft; ref: EntryRef } {
  const group = groupForAction(action)
  if (!group) throw new LibraryError('动作库只能保存组合键、宏和连发')
  let finalName: string
  if (name === undefined || !name.trim()) finalName = nextAutoName(draft, group)
  else {
    finalName = uniqueName(draft, group, name.trim())
    const bad = validateName(draft, group, finalName)
    if (bad) throw new LibraryError(bad)
  }
  const list = [...libraryEntries(draft, group), { name: finalName, action: clone(action) }]
  return { draft: withGroup(draft, group, list), ref: { group, index: list.length - 1 } }
}

/** Renames one entry. Throws LibraryError when validateName rejects the (trimmed) name. */
export function renameEntry(draft: Draft, ref: EntryRef, name: string): Draft {
  const entry = mustGet(draft, ref)
  const n = name.trim()
  if (n === entry.name) return draft
  const bad = validateName(draft, ref.group, n, ref.index)
  if (bad) throw new LibraryError(bad)
  const list = libraryEntries(draft, ref.group).map((e, i) => (i === ref.index ? { ...e, name: n } : e))
  return withGroup(draft, ref.group, list)
}

export function removeEntry(draft: Draft, ref: EntryRef): Draft {
  mustGet(draft, ref)
  return withGroup(draft, ref.group, libraryEntries(draft, ref.group).filter((_, i) => i !== ref.index))
}

/** Inserts a copy right after the entry, named "<name> 副本" (made unique). */
export function duplicateEntry(draft: Draft, ref: EntryRef): { draft: Draft; ref: EntryRef } {
  const entry = mustGet(draft, ref)
  let name = uniqueName(draft, ref.group, `${entry.name} 副本`)
  if (name.length > NAME_MAX) name = nextAutoName(draft, ref.group)
  const list = [...libraryEntries(draft, ref.group)]
  list.splice(ref.index + 1, 0, { name, action: clone(entry.action) })
  return { draft: withGroup(draft, ref.group, list), ref: { group: ref.group, index: ref.index + 1 } }
}

/** The action to assign to a key: a fresh copy of the entry's action (null when the entry does not exist). */
export function applyEntry(draft: Draft, ref: EntryRef): Action | null {
  const entry = entryAt(draft, ref)
  return entry ? clone(entry.action) : null
}

// --- equality --------------------------------------------------------------------------------------------------

/** A CodeRef as its device code number when it resolves ("KeyA" and 4 are the same code), else as given. */
function canonCode(ref: unknown): unknown {
  if (typeof ref !== 'string' && typeof ref !== 'number') return ref
  return resolveCodeRef(ref)?.value ?? ref
}

const CODE_FIELDS = new Set(['code', 'tap', 'down', 'up'])

/** Deep copy with code references canonicalized and undefined properties dropped. */
function canon(v: unknown, key?: string): unknown {
  if (key !== undefined && CODE_FIELDS.has(key)) return canonCode(v)
  if (Array.isArray(v)) return key === 'keys' ? v.map(canonCode) : v.map((x) => canon(x))
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = canon(x, k)
    }
    return out
  }
  return v
}

/**
 * Structural equality of two actions: same type, same fields, same steps in the same order. Code references are
 * compared by device code ("KeyA" equals 4) and undefined properties are ignored; nothing else is normalized
 * (a `tap` step is not equal to a `down` + `up` pair).
 */
export function actionsEqual(a: Action, b: Action): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}

/** Keys (both layers, layout order) whose action deep-equals the entry's action. */
export function usages(draft: Draft, entry: EntryRef | NamedAction | Action): KeyUsage[] {
  const action = 'type' in entry ? entry : 'action' in entry ? entry.action : entryAt(draft, entry)?.action
  if (!action) return []
  const target = JSON.stringify(canon(action))
  const out: KeyUsage[] = []
  for (const layer of LAYERS) {
    for (const key of KEYS) {
      const a = draft.layers[layer]?.[key.id]
      if (a && a.type === action.type && JSON.stringify(canon(a)) === target) out.push({ layer, keyId: key.id })
    }
  }
  return out
}

/** The first entry whose action deep-equals `action` (e.g. to mark the entry the selected key uses). */
export function findEntry(draft: Draft, action: Action | null | undefined): EntryRef | null {
  const group = groupForAction(action)
  if (!group || !action) return null
  const index = libraryEntries(draft, group).findIndex((e) => actionsEqual(e.action, action))
  return index < 0 ? null : { group, index }
}
