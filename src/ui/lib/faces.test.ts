import { describe, expect, it } from 'vitest'
import { FACTORY } from '../../device/layout'
import type { LayerId } from '../../device/types'
import type { SlotTable } from '../../protocol/slots'
import { derive, factoryDraft, type Draft } from '../state/editor'
import { buildFaces } from './faces'

const faces = (draft: Draft, layer: LayerId = 'base', device: SlotTable | null = FACTORY) =>
  buildFaces(draft, derive(draft, device).status, layer)

describe('buildFaces', () => {
  it('shows one name on unchanged base keys and two once a key is changed', () => {
    const d = factoryDraft()
    const before = faces(d)
    expect(before.delete).toMatchObject({ main: 'Del', legend: undefined, tag: undefined, changed: false, description: '' })
    expect(before.caps).toMatchObject({ main: 'Caps', legend: undefined })

    d.layers.base.delete = { type: 'key', code: 'Backspace' }
    d.layers.base.f1 = { type: 'key', code: 'AudioVolumeMute' }
    const after = faces(d)
    expect(after.delete).toMatchObject({ main: 'Bksp', legend: 'Delete', changed: true, pending: true, description: '与出厂不同，未写入' })
    expect(after.f1).toMatchObject({ main: 'Mute', legend: 'F1', tag: undefined })
  })

  it('keeps legend and tag on every Fn-layer key and gives Fn-layer faces no Fn hint', () => {
    const fn = faces(factoryDraft(), 'fn')
    expect(fn.f1).toMatchObject({ main: 'PC', legend: 'F1', tag: undefined, changed: false, fn: undefined })
    expect(fn.h).toMatchObject({ main: '', legend: 'H', empty: true })
    // unknown device functions are a "?", their code is in the title
    expect(fn.grave).toMatchObject({ main: '?', legend: '`' })
    expect(fn.grave.title).toMatch(/0xA0/)
    // only combos, macros and repeats keep a corner tag
    const d = factoryDraft()
    d.layers.fn.h = { type: 'combo', keys: ['ControlLeft', 'KeyC'] }
    expect(faces(d, 'fn').h).toMatchObject({ main: 'Ctrl+C', tag: '组合' })
  })

  it('puts the Fn-layer function on base caps, except hex device codes, lighting codes and repeats', () => {
    const f = faces(factoryDraft())
    expect(f.f1.fn).toBe('PC')
    expect(f.esc.fn).toBe('RowLk')
    expect(f.f12.fn).toBe('Prog')
    // nothing on Fn+H
    expect(f.h.fn).toBeUndefined()
    // unknown device functions (0xA0…) and backlight-era codes stay off the cap
    for (const id of ['grave', 'g', 'b', 'z', 'pgup', 'pgdn', '1', '2', '3', 'up', 'down']) expect(f[id].fn, id).toBeUndefined()
    // unverified codes without a backlight name still show
    expect(f.f9.fn).toBe('Scan')
    // Fn is Fn on both layers: no hint repeating the main name
    expect(f.fn.fn).toBeUndefined()

    const d = factoryDraft()
    d.layers.fn.h = { type: 'combo', keys: ['ControlLeft', 'KeyC'] }
    d.layers.fn.j = { type: 'raw', packets: [`00F0023600010100${'0'.repeat(112)}`] }
    d.layers.fn.k = { type: 'key', code: 'BacklightToggle' }
    const g = faces(d)
    expect(g.h.fn).toBe('Ctrl+C')
    expect(g.j.fn).toBeUndefined()
    expect(g.k.fn).toBeUndefined()
  })

  it('names both layers in the title and keeps the accessible description', () => {
    const d = factoryDraft()
    d.layers.base.caps = { type: 'combo', keys: [] }
    const f = faces(d, 'base', null)
    expect(f.f1.title).toBe('基础层：F1 / Fn 层：我的电脑')
    expect(f.grave.title).toMatch(/^基础层：.+ \/ Fn 层：.*0xA0/)
    // before any read nothing is 未写入
    expect(f.caps).toMatchObject({ invalid: true, pending: false, description: '与出厂不同，有错误' })
    expect(f.caps.title).toMatch(/^基础层：组合键.* \/ Fn 层：无$/)
  })
})
