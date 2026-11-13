import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Slot, SlotTable } from '../protocol/slots'
import {
  CODES,
  CODE_CATEGORIES,
  codeById,
  codeByValue,
  codeForKeyboardEventCode,
  codeLabel,
  codeShort,
  resolveCodeRef,
} from './codes'
import { BOARD_HEIGHT_U, BOARD_WIDTH_U, FACTORY, KEYS, factoryTable, keyById, keyByNo } from './layout'
import { KEY_COUNT } from './types'

const RE_DIR = new URL('../../../docs/re/', import.meta.url)
const readDoc = (name: string) => readFileSync(new URL(name, RE_DIR), 'utf8')

const EXPECTED_KEY_IDS = [
  'esc f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 f11 f12 prtsc pause delete',
  'grave 1 2 3 4 5 6 7 8 9 0 minus equal backspace home',
  'tab q w e r t y u i o p lbracket rbracket backslash pgup',
  'caps a s d f g h j k l semicolon quote enter pgdn',
  'lshift z x c v b n m comma period slash rshift up end',
  'lctrl lwin lalt space ralt fn rctrl left down right',
].map((r) => r.split(' '))

// --- live capture helpers -------------------------------------------------------------------------------------

interface CaptureEvent {
  kind: string
  data?: string
  text?: string
}

const capture: CaptureEvent[] = readDoc('live-capture.jsonl')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as CaptureEvent)

/** 64-byte payload of a captured report (drops the leading report id). */
const payload = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16))).subarray(1)

/** Slot replies (00 F0 ...) read from the device, grouped by the preceding step marker ("STEP1", ...). */
function slotReadsByStep(): Map<string, Uint8Array[]> {
  const steps = new Map<string, Uint8Array[]>()
  let step = 'start'
  for (const e of capture) {
    if (e.kind === 'marker') step = e.text!.split(' ')[0]
    if (e.kind !== 'R' || !e.data) continue
    const p = payload(e.data)
    if (p[0] !== 0x00 || p[1] !== 0xf0) continue
    if (!steps.has(step)) steps.set(step, [])
    steps.get(step)!.push(p)
  }
  return steps
}

/** Codes carried by a sequence of slot packets (type 0 lists, type 1 emulate keys, macro events). */
function codesInPackets(packets: Uint8Array[]): number[] {
  const out: number[] = []
  let macro: { key: string; len: number; hasDelays: boolean; data: number[] } | null = null
  for (const p of packets) {
    const type = p[4]
    if (type === 0) out.push(...p.subarray(6, 6 + p[5]))
    else if (type === 1) out.push(...p.subarray(8, 8 + p[7]))
    else if (type >= 2 && type <= 4) {
      const key = `${p[2]}/${p[3]}`
      if (!macro || macro.key !== key) macro = { key, len: (p[9] << 8) | p[10], hasDelays: p[6] === 1, data: [] }
      macro.data.push(...p.subarray(11))
      if (macro.data.length >= macro.len) {
        const data = macro.data.slice(0, macro.len)
        for (let i = 0; i < data.length; i += macro.hasDelays ? 4 : 1) {
          if (macro.hasDelays && i + 1 < data.length) expect(data[i + 1]).toBe(0xc8)
          out.push(data[i])
        }
        macro = null
      }
    } else throw new Error(`unexpected slot type ${type}`)
  }
  return out
}

/** Builds a slot table from a single-packet-per-slot read (types 0 only, as in a factory read). */
function tableFromRead(packets: Uint8Array[]): SlotTable {
  const t: SlotTable = { base: [], fn: [] }
  for (const p of packets) {
    expect(p[4]).toBe(0)
    const codes = [...p.subarray(6, 6 + p[5])]
    const slot: Slot = codes.length ? { kind: 'codes', codes } : { kind: 'empty' }
    ;(p[2] === 1 ? t.base : t.fn)[p[3] - 1] = slot
  }
  return t
}

// --- layout ---------------------------------------------------------------------------------------------------

describe('layout', () => {
  it('has 84 keys in key-number order with the expected ids', () => {
    expect(KEYS).toHaveLength(KEY_COUNT)
    KEYS.forEach((k, i) => expect(k.no).toBe(i + 1))
    expect(KEYS.map((k) => k.id)).toEqual(EXPECTED_KEY_IDS.flat())
    expect(new Set(KEYS.map((k) => k.id)).size).toBe(84)
    expect(new Set(KEYS.map((k) => k.no)).size).toBe(84)
  })

  it('places every row contiguously across 16u', () => {
    expect(BOARD_WIDTH_U).toBe(16)
    expect(BOARD_HEIGHT_U).toBe(6)
    for (let row = 1; row <= BOARD_HEIGHT_U; row++) {
      const keys = KEYS.filter((k) => k.row === row)
      expect(keys.map((k) => k.id)).toEqual(EXPECTED_KEY_IDS[row - 1])
      let x = 0
      for (const k of keys) {
        expect(k.y).toBe(row - 1)
        expect(k.x).toBeCloseTo(x, 9)
        x += k.w
      }
      expect(x).toBeCloseTo(BOARD_WIDTH_U, 9)
    }
  })

  it('has printed legends and Fn-layer sub-legends', () => {
    expect(keyById('delete')?.label).toBe('Delete')
    expect(keyById('caps')?.label).toBe('Caps Lock')
    expect(keyById('lshift')?.label).toBe('Shift')
    expect(keyById('up')?.label).toBe('↑')
    expect(keyById('space')).toMatchObject({ label: '', w: 7 })
    expect(keyById('esc')?.sub).toBe('RowLk')
    expect(keyById('prtsc')?.sub).toBe('Num')
    expect(keyById('q')?.sub).toBe('Mute')
    expect(keyById('grave')?.sub).toBe('0xA0')
    expect(keyById('f10')?.sub).toBeUndefined()
    expect(keyById('fn')?.sub).toBeUndefined()
  })

  it('looks keys up by id and number', () => {
    expect(keyById('caps')?.no).toBe(47)
    expect(keyById('CAPS')).toBeUndefined()
    expect(keyByNo(80)?.id).toBe('fn')
    expect(keyByNo(0)).toBeUndefined()
    expect(keyByNo(85)).toBeUndefined()
    expect(keyByNo(1.5)).toBeUndefined()
  })
})

// --- factory table --------------------------------------------------------------------------------------------

describe('FACTORY', () => {
  it('equals config.pro slot by slot', () => {
    const pro = readDoc('samples/config.pro')
    const re = /<KEY ID="(\d+)" Level="(\d)" Mode="(\d+)" HWCode="(\d+)">/g
    const matches = [...pro.matchAll(re)]
    expect(matches).toHaveLength(168)
    for (const [, id, level, mode, hw] of matches) {
      const [m, h] = [Number(mode), Number(hw)]
      expect([2, 3, 4]).not.toContain(m)
      const expected: Slot =
        m === 0 ? { kind: 'empty' } : { kind: 'codes', codes: m === 6 && h === 199 ? [130, 130] : [h] }
      const layer = level === '0' ? FACTORY.base : FACTORY.fn
      expect(layer[Number(id) - 1], `KEY ${id} level ${level}`).toEqual(expected)
    }
  })

  it('equals what the device returned (STEP1 office-mode read and STEP5b program-mode read after restore)', () => {
    const steps = slotReadsByStep()
    for (const step of ['STEP1', 'STEP5b']) {
      const packets = steps.get(step)!
      expect(packets).toHaveLength(168)
      expect(tableFromRead(packets)).toEqual(FACTORY)
    }
  })

  it('maps every non-Fn base-layer key to a keyboard code and keeps Fn on both layers', () => {
    KEYS.forEach((k, i) => {
      const slot = FACTORY.base[i]
      if (k.id === 'fn') return
      expect(slot.kind).toBe('codes')
      if (slot.kind === 'codes') expect(codeByValue(slot.codes[0])?.category).toBe('key')
    })
    const fn = keyById('fn')!.no - 1
    expect(FACTORY.base[fn]).toEqual({ kind: 'codes', codes: [156] })
    expect(FACTORY.fn[fn]).toEqual({ kind: 'codes', codes: [156] })
  })

  it('is frozen; factoryTable() returns an independent mutable copy', () => {
    expect(Object.isFrozen(FACTORY.base)).toBe(true)
    const t = factoryTable()
    expect(t).toEqual(FACTORY)
    t.base[0] = { kind: 'empty' }
    const s = t.fn[0]
    if (s.kind === 'codes') s.codes.push(1)
    expect(FACTORY.base[0]).toEqual({ kind: 'codes', codes: [1] })
    expect(FACTORY.fn[0]).toEqual({ kind: 'codes', codes: [151] })
  })
})

// --- codes ----------------------------------------------------------------------------------------------------

describe('codes', () => {
  const codesJson = JSON.parse(readDoc('codes.json')) as { code: number; wire: number[] }[]

  it('has one entry per codes.json code except 0, with matching wire bytes', () => {
    const expected = codesJson.filter((c) => c.code !== 0)
    expect(CODES).toHaveLength(expected.length)
    for (const c of expected) expect(codeByValue(c.code)?.wire, `code ${c.code}`).toEqual(c.wire)
    expect(codeByValue(0)).toBeUndefined()
    expect(codeByValue(199)?.wire).toEqual([130, 130])
  })

  it('has unique values and ids (also case-insensitively)', () => {
    expect(new Set(CODES.map((c) => c.value)).size).toBe(CODES.length)
    expect(new Set(CODES.map((c) => c.id)).size).toBe(CODES.length)
    expect(new Set(CODES.map((c) => c.id.toLowerCase())).size).toBe(CODES.length)
  })

  it('uses the agreed ids', () => {
    const ids: Record<number, string> = {
      1: 'Escape', 15: 'Digit1', 43: 'KeyA', 55: 'ShiftLeft', 107: 'NumpadEnter', 111: 'MediaPlayPause',
      113: 'AudioVolumeUp', 118: 'LaunchApp1', 120: 'BrowserHome', 75: 'WakeUp', 76: 'Sleep', 77: 'Power',
      126: 'MouseMoveLeft', 130: 'MouseLeft', 134: 'MouseWheelDown', 199: 'MouseDoubleClick',
      135: 'BacklightToggle', 149: 'NKeyRolloverToggle', 151: 'NumberRowLock', 156: 'Fn', 159: 'ProgramMode',
      160: 'DeviceA0', 162: 'DeviceA2', 163: 'DeviceA3', 170: 'DeviceAA', 171: 'DeviceAB', 204: 'DeviceCC',
    }
    for (const [v, id] of Object.entries(ids)) expect(codeByValue(Number(v))?.id).toBe(id)
    expect(codeByValue(160)?.category).toBe('special')
  })

  it('has short labels of at most 6 characters and names in both languages', () => {
    for (const c of CODES) {
      expect([...c.short].length, c.id).toBeLessThanOrEqual(6)
      expect(c.short.length).toBeGreaterThan(0)
      expect(c.zh.length).toBeGreaterThan(0)
      expect(c.en.length).toBeGreaterThan(0)
    }
    expect(codeById('Fn')?.zh).toBe('Fn 键')
    expect(codeById('NumberRowLock')).toMatchObject({ zh: '数字行锁定', en: 'Number-row lock', short: 'RowLk' })
    expect(codeById('ShiftLeft')?.en).toBe('Left Shift')
    expect(codeById('ShiftRight')?.en).toBe('Right Shift')
  })

  it('assigns every code to a known category', () => {
    const cats = new Set(CODE_CATEGORIES.map((c) => c.id))
    for (const c of CODES) expect(cats.has(c.category), c.id).toBe(true)
  })

  it('marks pickable codes, .pro labels and caveats', () => {
    for (const v of [43, 72, 107, 75, 76, 77, 108, 130, 199, 135, 156, 159]) expect(codeByValue(v)?.pickable, `${v}`).toBe(true)
    for (const v of [140, 147, 149, 151, 154, 155, 160, 162, 163, 170, 171, 204]) {
      expect(codeByValue(v)?.pickable, `${v}`).toBe(false)
    }
    expect(codeByValue(76)?.proLabel).toBeNull()
    expect(codeByValue(160)?.proLabel).toBeNull()
    expect(codeByValue(77)?.proLabel).toBe('Power')
    expect(codeByValue(55)?.proLabel).toBe('Left SHIFT')
    expect(codeByValue(76)?.note).toMatch(/Sleep/)
    for (const v of [144, 145, 146, 147, 148, 154, 155]) expect(codeByValue(v)?.note).toMatch(/unverified/)
    expect(codeByValue(160)?.note).toMatch(/unknown device function/i)
    expect(codeByValue(111)?.kb84Mode).toBe(5)
    expect(codeByValue(199)?.kb84Mode).toBe(6)
  })

  it('knows every code value the device returned in the live capture', () => {
    const seen = new Set<number>()
    for (const packets of slotReadsByStep().values()) for (const c of codesInPackets(packets)) seen.add(c)
    expect(seen.size).toBeGreaterThan(50)
    for (const v of seen) expect(codeByValue(v), `code ${v}`).toBeDefined()
    // The recorded macros (STEP3c/STEP3e) carried letters a..t.
    for (const v of [43, 60, 58, 45, 31]) expect(seen.has(v)).toBe(true)
  })
})

describe('code helpers', () => {
  it('codeById matches exactly, then case-insensitively', () => {
    expect(codeById('KeyA')?.value).toBe(43)
    expect(codeById('keya')?.value).toBe(43)
    expect(codeById('MOUSELEFT')?.value).toBe(130)
    expect(codeById('nope')).toBeUndefined()
  })

  it('resolveCodeRef resolves ids and raw numbers', () => {
    expect(resolveCodeRef('KeyA')).toEqual({ value: 43, wire: [43], info: codeByValue(43) })
    expect(resolveCodeRef('shiftleft')?.value).toBe(55)
    expect(resolveCodeRef('MouseDoubleClick')).toMatchObject({ value: 199, wire: [130, 130] })
    expect(resolveCodeRef(199)).toMatchObject({ value: 199, wire: [130, 130] })
    expect(resolveCodeRef(160)?.info?.id).toBe('DeviceA0')
    expect(resolveCodeRef(1)?.info?.id).toBe('Escape')
    expect(resolveCodeRef(250)).toEqual({ value: 250, wire: [250] })
    expect(resolveCodeRef(255)).toEqual({ value: 255, wire: [255] })
    for (const bad of [0, 256, -1, 1.5, Number.NaN]) expect(resolveCodeRef(bad), `${bad}`).toBeNull()
    for (const bad of ['', 'Nope', '43', 'IntlBackslash']) expect(resolveCodeRef(bad), bad).toBeNull()
  })

  it('resolveCodeRef returns a wire array the caller may mutate', () => {
    const r = resolveCodeRef('MouseDoubleClick')!
    r.wire.push(1)
    expect(codeById('MouseDoubleClick')?.wire).toEqual([130, 130])
    expect(Object.isFrozen(CODES)).toBe(true)
  })

  it('codeForKeyboardEventCode maps KeyboardEvent.code names', () => {
    expect(codeForKeyboardEventCode('KeyA')?.value).toBe(43)
    expect(codeForKeyboardEventCode('NumpadEnter')?.value).toBe(107)
    expect(codeForKeyboardEventCode('MetaLeft')?.value).toBe(68)
    expect(codeForKeyboardEventCode('OSLeft')?.value).toBe(68)
    expect(codeForKeyboardEventCode('AudioVolumeUp')?.value).toBe(113)
    expect(codeForKeyboardEventCode('IntlBackslash')).toBeUndefined()
    expect(codeForKeyboardEventCode('IntlYen')).toBeUndefined()
    expect(codeForKeyboardEventCode('keya')).toBeUndefined()
    expect(codeForKeyboardEventCode('MouseLeft')).toBeUndefined()
    expect(codeForKeyboardEventCode('Fn')).toBeUndefined()
  })

  it('codeLabel and codeShort describe any CodeRef', () => {
    expect(codeLabel('KeyA', 'en')).toBe('A')
    expect(codeLabel(112, 'zh')).toBe('静音')
    expect(codeLabel('Fn', 'zh')).toBe('Fn 键')
    expect(codeLabel(165, 'en')).toBe('Device function 0xA5')
    expect(codeLabel(165, 'zh')).toBe('设备功能 0xA5')
    expect(codeLabel('Bogus', 'en')).toBe('Bogus')
    expect(codeShort('AudioVolumeDown')).toBe('Vol−')
    expect(codeShort(204)).toBe('0xCC')
    expect(codeShort(165)).toBe('0xA5')
  })
})
