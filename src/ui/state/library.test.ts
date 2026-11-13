import { describe, expect, it } from 'vitest'
import { parseProfileJson } from '../../format/normalize'
import { serializeProfile } from '../../format/serialize'
import type { Action, NamedAction } from '../../format/types'
import { parseProFile, toProFile } from '../../kb84/pro'
import { factoryDraft, type Draft } from './editor'
import {
  actionsEqual,
  addToLibrary,
  applyEntry,
  duplicateEntry,
  entryAt,
  findEntry,
  GROUP_LABEL,
  groupForAction,
  groupLabel,
  LIBRARY_GROUPS,
  libraryCount,
  libraryEntries,
  LibraryError,
  nextAutoName,
  removeEntry,
  renameEntry,
  usages,
  validateName,
} from './library'

const copy: Action = { type: 'combo', keys: ['ControlLeft', 'KeyC'] }
const paste: Action = { type: 'combo', keys: ['ControlLeft', 'KeyV'] }
const fixedMacro: Action = { type: 'macro', play: 'repeat', repeat: 3, interval: 40, steps: [{ down: 'KeyH' }, { up: 'KeyH' }, { down: 'KeyI' }, { up: 'KeyI' }] }
const recMacro: Action = { type: 'macro', play: 'hold', steps: [{ down: 'ShiftLeft' }, { wait: 25 }, { down: 'KeyA' }, { wait: 60 }, { up: 'KeyA' }, { wait: 5 }, { up: 'ShiftLeft' }] }
const emu: Action = { type: 'emulate', keys: ['KeyZ', 'KeyX'], interval: 120 }

function build(...actions: Action[]): Draft {
  return actions.reduce((d, a) => addToLibrary(d, a).draft, factoryDraft())
}

describe('library naming', () => {
  it('auto-names entries by action type like KB84, with the display names', () => {
    const d = build(copy, fixedMacro, paste, emu, recMacro)
    expect(libraryEntries(d, 'combos').map((e) => e.name)).toEqual(['组合键1', '组合键2'])
    expect(libraryEntries(d, 'macros').map((e) => e.name)).toEqual(['宏1', '宏2'])
    expect(libraryEntries(d, 'emulates').map((e) => e.name)).toEqual(['连发1'])
    expect(libraryCount(d)).toBe(5)
    expect(GROUP_LABEL).toEqual({ combo: '组合键', macro: '宏', emulate: '连发' })
    expect(LIBRARY_GROUPS.map(groupLabel)).toEqual(['组合键', '宏', '连发'])
  })

  it('keeps KB84 names from files and continues the numbering', () => {
    const fromFile: Draft = { ...factoryDraft(), library: { macros: [{ name: '宏定义1', action: fixedMacro }] } }
    const d = addToLibrary(fromFile, recMacro).draft
    expect(libraryEntries(d, 'macros').map((e) => e.name)).toEqual(['宏定义1', '宏2'])
  })

  it('skips taken names after removals and renames', () => {
    let d = build(copy, paste)
    d = removeEntry(d, { group: 'combos', index: 0 }) // left: 组合键2
    expect(nextAutoName(d, 'combos')).toBe('组合键3')
    d = renameEntry(d, { group: 'combos', index: 0 }, '粘贴')
    expect(nextAutoName(d, 'combos')).toBe('组合键2')
  })

  it('makes given names unique and validates them', () => {
    let d = addToLibrary(factoryDraft(), copy, '  复制 ').draft
    d = addToLibrary(d, paste, '复制').draft
    expect(libraryEntries(d, 'combos').map((e) => e.name)).toEqual(['复制', '复制 2'])
    expect(validateName(d, 'combos', '复制')).toMatch(/已经有/)
    expect(validateName(d, 'combos', '复制', 0)).toBeNull()
    expect(validateName(d, 'macros', '复制')).toBeNull()
    expect(validateName(d, 'combos', '   ')).toBe('名称不能为空')
    expect(validateName(d, 'combos', 'a\nb')).toMatch(/控制字符/)
    expect(validateName(d, 'combos', 'x'.repeat(41))).toMatch(/最多/)
    expect(() => renameEntry(d, { group: 'combos', index: 1 }, '复制')).toThrow(LibraryError)
    expect(() => addToLibrary(d, copy, 'x'.repeat(41))).toThrow(LibraryError)
  })

  it('rejects actions the library cannot hold', () => {
    for (const a of [{ type: 'none' }, { type: 'key', code: 'KeyA' }, { type: 'raw', packets: [] }] as Action[]) {
      expect(groupForAction(a)).toBeNull()
      expect(() => addToLibrary(factoryDraft(), a)).toThrow(LibraryError)
    }
  })
})

describe('library operations', () => {
  it('never mutates the input and copies actions', () => {
    const base = factoryDraft()
    const before = JSON.stringify(base)
    const action = structuredClone(copy)
    const { draft, ref } = addToLibrary(base, action)
    expect(JSON.stringify(base)).toBe(before)
    ;(action as { keys: string[] }).keys.push('KeyX')
    expect(entryAt(draft, ref)!.action).toEqual(copy)
    const applied = applyEntry(draft, ref)!
    expect(applied).toEqual(copy)
    expect(applied).not.toBe(entryAt(draft, ref)!.action)
    expect(applyEntry(draft, { group: 'combos', index: 9 })).toBeNull()
  })

  it('duplicates right after the original and removes entries, pruning empty groups', () => {
    let d = build(copy, paste)
    const dup = duplicateEntry(d, { group: 'combos', index: 0 })
    d = dup.draft
    expect(dup.ref).toEqual({ group: 'combos', index: 1 })
    expect(libraryEntries(d, 'combos').map((e) => e.name)).toEqual(['组合键1', '组合键1 副本', '组合键2'])
    expect(duplicateEntry(d, { group: 'combos', index: 0 }).draft.library!.combos![1].name).toBe('组合键1 副本 2')
    d = removeEntry(removeEntry(removeEntry(d, { group: 'combos', index: 0 }), { group: 'combos', index: 0 }), { group: 'combos', index: 0 })
    expect(d.library).toBeUndefined()
    expect(serializeProfile(d)).toBe(serializeProfile(factoryDraft()))
    expect(() => removeEntry(d, { group: 'combos', index: 0 })).toThrow(LibraryError)
  })

  it('renaming to the same name returns the same draft', () => {
    const d = build(copy)
    expect(renameEntry(d, { group: 'combos', index: 0 }, ' 组合键1 ')).toBe(d)
  })
})

describe('usages and equality', () => {
  it('finds every key whose action deep-equals the entry', () => {
    let d = build(copy, fixedMacro)
    d = { ...d, layers: { base: { ...d.layers.base, f1: structuredClone(copy), caps: { type: 'combo', keys: [67, 'KeyC'] } }, fn: { ...d.layers.fn, f1: structuredClone(copy) } } }
    // ControlLeft is device code 67, so [67, "KeyC"] is the same combo.
    expect(usages(d, { group: 'combos', index: 0 })).toEqual([
      { layer: 'base', keyId: 'f1' },
      { layer: 'base', keyId: 'caps' },
      { layer: 'fn', keyId: 'f1' },
    ])
    expect(usages(d, { group: 'macros', index: 0 })).toEqual([])
    expect(usages(d, { group: 'emulates', index: 0 })).toEqual([])
    expect(usages(d, entryAt(d, { group: 'combos', index: 0 })!)).toHaveLength(3)
    expect(usages(d, paste)).toEqual([])
  })

  it('compares structure exactly apart from code spelling and undefined fields', () => {
    expect(actionsEqual(copy, { type: 'combo', keys: ['ControlLeft', 'KeyC'] })).toBe(true)
    expect(actionsEqual(copy, { type: 'combo', keys: ['KeyC', 'ControlLeft'] })).toBe(false)
    expect(actionsEqual({ type: 'macro', play: 'hold', interval: undefined, steps: [{ tap: 'KeyA' }] }, { type: 'macro', play: 'hold', steps: [{ tap: 43 }] })).toBe(true)
    expect(actionsEqual({ type: 'macro', play: 'hold', steps: [{ tap: 'KeyA' }] }, { type: 'macro', play: 'hold', steps: [{ down: 'KeyA' }, { up: 'KeyA' }] })).toBe(false)
    expect(actionsEqual(emu, { ...emu, interval: 121 } as Action)).toBe(false)
    expect(actionsEqual(fixedMacro, { ...fixedMacro, repeat: 2 } as Action)).toBe(false)
  })

  it('finds the entry matching an action', () => {
    const d = build(copy, paste, emu)
    expect(findEntry(d, paste)).toEqual({ group: 'combos', index: 1 })
    expect(findEntry(d, emu)).toEqual({ group: 'emulates', index: 0 })
    expect(findEntry(d, fixedMacro)).toBeNull()
    expect(findEntry(d, { type: 'key', code: 'KeyA' })).toBeNull()
    expect(findEntry(d, null)).toBeNull()
  })
})

describe('library round trips', () => {
  const groupsOf = (d: Draft) => Object.fromEntries(LIBRARY_GROUPS.map((g) => [g, libraryEntries(d, g)])) as Record<string, readonly NamedAction[]>
  let d = build(copy, fixedMacro, paste, emu, recMacro)
  d = renameEntry(d, { group: 'combos', index: 1 }, '粘贴 & <特殊> "名称"')
  d = duplicateEntry(d, { group: 'emulates', index: 0 }).draft
  d = { ...d, layers: { ...d.layers, base: { ...d.layers.base, caps: applyEntry(d, { group: 'macros', index: 1 })! } } }

  it('survives serializeProfile / parseProfileJson unchanged', () => {
    const { profile, issues } = parseProfileJson(serializeProfile(d))
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(profile!.library).toEqual(d.library)
    expect(usages(profile!, { group: 'macros', index: 1 })).toEqual([{ layer: 'base', keyId: 'caps' }])
    // diff-factory style keeps the library too
    expect(parseProfileJson(serializeProfile(d, { style: 'diff-factory' })).profile!.library).toEqual(d.library)
  })

  it('survives KB84 .pro export / import (library <-> Predefined* sections)', () => {
    const text = toProFile(d)
    expect(text).toContain('<PredefinedCombo>')
    expect(text).toContain('t1="组合键1"')
    expect(text).toContain('t1="粘贴 &amp; &lt;特殊&gt; &quot;名称&quot;"')
    expect(text).toContain('t1="连发1 副本"')
    const { profile, issues } = parseProFile(text)
    expect(issues).toEqual([])
    expect(groupsOf(profile!)).toEqual(groupsOf(d))
    expect(usages(profile!, { group: 'macros', index: 1 })).toEqual([{ layer: 'base', keyId: 'caps' }])
    // and back again: byte-identical
    expect(toProFile(profile!)).toBe(text)
  })

  it('an emptied library exports empty Predefined sections and imports as no library', () => {
    const empty = removeEntry(build(copy), { group: 'combos', index: 0 })
    const { profile } = parseProFile(toProFile(empty))
    expect(profile!.library).toBeUndefined()
  })
})
