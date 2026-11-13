import { describe, expect, it } from 'vitest'
import { KEYS } from '../../device/layout'
import { profileToTable } from '../../format/compile'
import { normalizeProfile } from '../../format/normalize'
import { factoryDraft } from '../state/editor'
import { clearAllDraft } from './clearAll'

const nonEmpty = (d: ReturnType<typeof factoryDraft>) =>
  (['base', 'fn'] as const).flatMap((l) => KEYS.filter((k) => d.layers[l][k.id]?.type !== 'none').map((k) => `${l}/${k.id}`))

describe('clearAllDraft', () => {
  it('keeps Fn on both layers and the mode switch on Fn+F12 by default', () => {
    const before = factoryDraft()
    const { draft, kept } = clearAllDraft(before)
    expect(nonEmpty(draft).sort()).toEqual(['base/fn', 'fn/f12', 'fn/fn'])
    expect(draft.layers.base.fn).toEqual({ type: 'key', code: 'Fn' })
    expect(draft.layers.fn.fn).toEqual({ type: 'key', code: 'Fn' })
    expect(draft.layers.fn.f12).toEqual({ type: 'key', code: 'ProgramMode' })
    expect(kept.map((k) => `${k.layer}/${k.keyId}:${k.what}`)).toEqual(['base/fn:fn', 'fn/f12:mode', 'fn/fn:fn'])
    // input untouched, result compiles
    expect(before.layers.base.a).toEqual({ type: 'key', code: 'KeyA' })
    const { profile, issues } = normalizeProfile(draft)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(profileToTable(profile!).base[0]).toEqual({ kind: 'empty' })
  })

  it('keeps Fn / ProgramMode where the user moved them and keeps the library', () => {
    const d = factoryDraft()
    const moved = {
      ...d,
      layers: {
        base: { ...d.layers.base, fn: { type: 'key' as const, code: 'KeyB' }, caps: { type: 'key' as const, code: 156 } },
        fn: { ...d.layers.fn, fn: { type: 'none' as const }, caps: { type: 'key' as const, code: 'Fn' }, f12: { type: 'none' as const }, f11: { type: 'key' as const, code: 'ProgramMode' } },
      },
      library: { combos: [{ name: '组合键1', action: { type: 'combo' as const, keys: ['ControlLeft', 'KeyC'] } }] },
    }
    const { draft } = clearAllDraft(moved)
    expect(nonEmpty(draft).sort()).toEqual(['base/caps', 'fn/caps', 'fn/f11'])
    expect(draft.library).toEqual(moved.library)
  })

  it('clears everything when asked to', () => {
    const { draft, kept } = clearAllDraft(factoryDraft(), { keepFn: false })
    expect(nonEmpty(draft)).toEqual([])
    expect(kept).toEqual([])
  })
})

describe('clearAllDraft edge cases (review regressions)', () => {
  it('lists every kept key once and matches the result when the mode switch sat on the Fn key', () => {
    const d = factoryDraft()
    // No Fn anywhere; ProgramMode on the base-layer Fn key position.
    const draft = {
      ...d,
      layers: {
        base: { ...d.layers.base, fn: { type: 'key' as const, code: 'ProgramMode' } },
        fn: { ...d.layers.fn, fn: { type: 'key' as const, code: 'KeyA' }, f12: { type: 'none' as const } },
      },
    }
    const { draft: out, kept } = clearAllDraft(draft)
    const ids = kept.map((k) => `${k.layer}/${k.keyId}`)
    expect(new Set(ids).size).toBe(ids.length)
    // What the dialog lists is what the cleared draft holds.
    for (const k of kept) {
      expect(out.layers[k.layer][k.keyId]).toEqual({ type: 'key', code: k.what === 'fn' ? 'Fn' : 'ProgramMode' })
    }
    // Fn is back on the base layer, and a mode switch survives somewhere on the Fn layer.
    expect(out.layers.base.fn).toEqual({ type: 'key', code: 'Fn' })
    expect(kept.some((k) => k.layer === 'fn' && k.what === 'mode')).toBe(true)
  })
})
