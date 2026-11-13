/**
 * Editor state: the working profile with undo/redo history, the last table read from (or verified on) the
 * keyboard, and the selection. Pure reducer + derived per-key status; see useEditor.ts for the React binding.
 */
import { FACTORY, KEYS } from '../../device/layout'
import type { LayerId } from '../../device/types'
import { actionToSlot, profileToTable, tableToProfile } from '../../format/compile'
import { normalizeActionInput, normalizeProfile } from '../../format/normalize'
import type { Action, FormatIssue, NormalizedProfile } from '../../format/types'
import { slotsEqual } from '../../protocol/codec'
import type { Slot, SlotTable } from '../../protocol/slots'
import { issueTarget } from '../lib/issues'

/** The profile being edited. Same shape as a NormalizedProfile, but its actions may be invalid while editing. */
export type Draft = NormalizedProfile

interface Entry {
  draft: Draft
  /** What changed between this entry and the next state (shown as "撤销：…"). */
  label: string
}

export interface EditorState {
  past: Entry[]
  present: Draft
  future: Entry[]
  /** Coalescing key of the last edit and when it happened (typing in one field = one undo step). */
  lastCoalesce: string | null
  lastAt: number
  /** Last table read from the keyboard (or verified after a write); null before any read. */
  device: SlotTable | null
  layer: LayerId
  selected: string | null
}

export type EditorAction =
  | { type: 'setKey'; layer: LayerId; keyId: string; action: Action; label: string; coalesce?: string; at?: number }
  | { type: 'replace'; draft: Draft; label: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'setDevice'; table: SlotTable | null }
  | { type: 'select'; keyId: string | null; layer?: LayerId }
  | { type: 'setLayer'; layer: LayerId }

/** Undo steps kept; older ones are dropped. */
export const HISTORY_LIMIT = 200
const COALESCE_MS = 1500

export const factoryDraft = (): Draft => tableToProfile(FACTORY)

export function initialEditorState(draft: Draft = factoryDraft()): EditorState {
  return { past: [], present: draft, future: [], lastCoalesce: null, lastAt: 0, device: null, layer: 'base', selected: null }
}

function commit(s: EditorState, next: Draft, label: string, coalesce: string | null, at: number): EditorState {
  const merge = coalesce !== null && coalesce === s.lastCoalesce && at - s.lastAt < COALESCE_MS && s.past.length > 0
  const past = merge ? s.past : [...s.past, { draft: s.present, label }].slice(-HISTORY_LIMIT)
  return { ...s, past, present: next, future: [], lastCoalesce: coalesce, lastAt: at }
}

export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  switch (a.type) {
    case 'setKey': {
      const layerMap = { ...s.present.layers[a.layer], [a.keyId]: a.action }
      const next = { ...s.present, layers: { ...s.present.layers, [a.layer]: layerMap } }
      return commit(s, next, a.label, a.coalesce ?? null, a.at ?? Date.now())
    }
    case 'replace':
      return commit(s, a.draft, a.label, null, Date.now())
    case 'undo': {
      const prev = s.past.at(-1)
      if (!prev) return s
      return {
        ...s,
        past: s.past.slice(0, -1),
        present: prev.draft,
        future: [{ draft: s.present, label: prev.label }, ...s.future],
        lastCoalesce: null,
      }
    }
    case 'redo': {
      const next = s.future[0]
      if (!next) return s
      return {
        ...s,
        past: [...s.past, { draft: s.present, label: next.label }],
        present: next.draft,
        future: s.future.slice(1),
        lastCoalesce: null,
      }
    }
    case 'setDevice':
      return { ...s, device: a.table }
    case 'select':
      return { ...s, selected: a.keyId, layer: a.layer ?? s.layer }
    case 'setLayer':
      return { ...s, layer: a.layer }
  }
}

export interface KeyStatus {
  /** Compiled slot, or null when the action is invalid. */
  slot: Slot | null
  /** Differs from the factory default of this slot. */
  changed: boolean
  /** Differs from the last keyboard read ("未写入"); false before any read. */
  pending: boolean
  errors: number
  warnings: number
}

export type StatusMap = Record<LayerId, Record<string, KeyStatus>>

/** Compiles one action, or null when it does not validate on its own. */
export function compileAction(action: Action): Slot | null {
  const { action: norm } = normalizeActionInput(action)
  if (!norm) return null
  try {
    return actionToSlot(norm)
  } catch {
    return null
  }
}

export interface Derived {
  issues: FormatIssue[]
  errorCount: number
  warningCount: number
  /** The table to write; null while there are errors. */
  table: SlotTable | null
  normalized: NormalizedProfile | null
  status: StatusMap
  issuesByKey: Map<string, FormatIssue[]>
  changedCount: number
  pendingCount: number
}

export const keyRef = (layer: LayerId, keyId: string) => `${layer}/${keyId}`

export function derive(present: Draft, device: SlotTable | null): Derived {
  const { profile, issues } = normalizeProfile(present)
  const issuesByKey = new Map<string, FormatIssue[]>()
  for (const issue of issues) {
    const t = issueTarget(issue.path)
    if (!t) continue
    const k = keyRef(t.layer, t.keyId)
    issuesByKey.set(k, [...(issuesByKey.get(k) ?? []), issue])
  }
  const status = { base: {}, fn: {} } as StatusMap
  let changedCount = 0
  let pendingCount = 0
  for (const layer of ['base', 'fn'] as const) {
    KEYS.forEach((key, i) => {
      const slot = compileAction(present.layers[layer][key.id] ?? { type: 'none' })
      const changed = !slot || !slotsEqual(slot, FACTORY[layer][i])
      const pending = device !== null && (!slot || !slotsEqual(slot, device[layer][i]))
      const own = issuesByKey.get(keyRef(layer, key.id)) ?? []
      changedCount += changed ? 1 : 0
      pendingCount += pending ? 1 : 0
      status[layer][key.id] = {
        slot,
        changed,
        pending,
        errors: own.filter((x) => x.severity === 'error').length,
        warnings: own.filter((x) => x.severity === 'warning').length,
      }
    })
  }
  const errorCount = issues.filter((i) => i.severity === 'error').length
  return {
    issues,
    errorCount,
    warningCount: issues.length - errorCount,
    table: profile ? profileToTable(profile) : null,
    normalized: profile,
    status,
    issuesByKey,
    changedCount,
    pendingCount,
  }
}
