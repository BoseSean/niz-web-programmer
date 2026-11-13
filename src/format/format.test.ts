import { readFileSync, writeFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import { CODES } from '../device/codes'
import { FACTORY, KEYS, keyById } from '../device/layout'
import { LAYERS } from '../device/types'
import { encodeSlot, encodeWriteSequence, ReadAssembler, readEnd } from '../protocol/codec'
import type { MacroPlayMode, Slot, SlotTable } from '../protocol/slots'
import {
  actionToSlot,
  normalizeActionInput,
  normalizeProfile,
  parseProfileJson,
  profileToTable,
  serializeProfile,
  slotToAction,
  tableToProfile,
} from './index'
import { schemaText } from './schema'
import type { Action, FormatIssue, NormalizedProfile } from './types'

const ROOT = new URL('../../../', import.meta.url)
const readText = (path: string) => readFileSync(new URL(path, ROOT), 'utf8')
const readJson = (path: string) => JSON.parse(readText(path)) as unknown

const SCHEMA_PATH = 'format/plum-keymap.schema.json'
const FACTORY_EXAMPLE = 'format/examples/factory-84ec-s.json'
const DEMO_EXAMPLE = 'format/examples/demo.json'
/** `$schema` written into the examples (they sit next to the schema's folder). */
const EXAMPLE_SCHEMA_URL = '../plum-keymap.schema.json'

const FACTORY_META = {
  name: 'Factory default (84EC-S)',
  description:
    '84EC-S 出厂按键方案 (办公模式读取结果，等同于 config.pro) (factory key map of the 84EC-S: the Office-mode read, identical to config.pro)',
}

// --- captured device reads --------------------------------------------------------------------------------------

interface CaptureEvent {
  kind: string
  data?: string
  text?: string
}

/** Slot packets (64-byte payloads starting 00 F0) the device returned after the given step marker. */
function capturedReads(step: string): Uint8Array[] {
  const out: Uint8Array[] = []
  let current = ''
  for (const line of readText('docs/re/live-capture.jsonl').split(/\r?\n/)) {
    if (!line) continue
    const e = JSON.parse(line) as CaptureEvent
    if (e.kind === 'marker') current = e.text!.split(' ')[0]
    if (current !== step || e.kind !== 'R' || !e.data) continue
    const p = Uint8Array.from(e.data.match(/../g)!, (b) => parseInt(b, 16)).subarray(1)
    if (p[0] === 0x00 && p[1] === 0xf0) out.push(p)
  }
  return out
}

/** Minimal wire decoder (docs/re/SPEC_DRAFT.en.md d.2-d.4), grouping consecutive packets of one slot. */
function decodeSlots(packets: Uint8Array[]): Map<string, Slot> {
  const slots = new Map<string, Slot>()
  for (let i = 0; i < packets.length; ) {
    const p = packets[i]
    const id = `${p[2]}/${p[3]}`
    const type = p[4]
    if (type === 0) {
      slots.set(id, p[5] === 0 ? { kind: 'empty' } : { kind: 'codes', codes: [...p.subarray(6, 6 + p[5])] })
      i++
    } else if (type === 1) {
      slots.set(id, { kind: 'emulate', value: (p[5] << 8) | p[6], codes: [...p.subarray(8, 8 + p[7])] })
      i++
    } else {
      const len = (p[9] << 8) | p[10]
      const data: number[] = []
      while (data.length < len) data.push(...packets[i++].subarray(11, 64))
      const stream = data.slice(0, len)
      const hasDelays = p[6] === 1
      const events: number[] = []
      const delays: number[] = []
      for (let j = 0; j < stream.length; j += hasDelays ? 4 : 1) {
        events.push(stream[j])
        if (hasDelays && j + 4 < stream.length) {
          expect(stream[j + 1]).toBe(0xc8)
          delays.push((stream[j + 2] << 8) | stream[j + 3])
        }
      }
      const autoDelay = (p[7] << 8) | p[8]
      slots.set(id, { kind: 'macro', playMode: (type - 2) as MacroPlayMode, cycles: p[5], hasDelays, autoDelay, events, delays })
    }
  }
  return slots
}

const fnSlot = (slots: Map<string, Slot>, keyId: string) => slots.get(`2/${keyById(keyId)!.no}`)!

// --- helpers ----------------------------------------------------------------------------------------------------

const base = (layers: { base?: object; fn?: object } = {}, extra: object = {}) => ({
  format: 'plum-keymap',
  version: 1,
  device: '84EC-S',
  inherit: 'factory',
  layers: { base: {}, fn: {}, ...layers },
  ...extra,
})

const errors = (issues: FormatIssue[]) => issues.filter((i) => i.severity === 'error')
const warnings = (issues: FormatIssue[]) => issues.filter((i) => i.severity === 'warning')
const paths = (issues: FormatIssue[]) => issues.map((i) => i.path)

function fnAction(input: unknown) {
  return normalizeProfile(base({ fn: { h: input } }))
}

function mustNormalize(input: unknown): NormalizedProfile {
  const { profile, issues } = normalizeProfile(input)
  expect(errors(issues)).toEqual([])
  return profile!
}

// --- tests ------------------------------------------------------------------------------------------------------

describe('slot <-> action', () => {
  it('round-trips the factory table', () => {
    const profile = tableToProfile(FACTORY)
    expect(profileToTable(profile)).toEqual(FACTORY)
    expect(profile.layers.base.caps).toEqual({ type: 'key', code: 'CapsLock' })
    expect(profile.layers.base.fn).toEqual({ type: 'key', code: 'Fn' })
    expect(profile.layers.fn.grave).toEqual({ type: 'key', code: 'DeviceA0' })
    expect(profile.layers.fn.h).toEqual({ type: 'none' })
  })

  it('round-trips the five test slots read back from the device (STEP3c)', () => {
    const slots = decodeSlots(capturedReads('STEP3c'))
    expect(slots.size).toBe(168)
    const expected: Record<string, Action> = {
      h: { type: 'combo', keys: ['ShiftLeft', 'ControlLeft', 'KeyA'] },
      j: {
        type: 'macro',
        play: 'repeat',
        repeat: 2,
        interval: 30,
        steps: [{ tap: 'KeyA' }, { tap: 'KeyB' }, { tap: 'KeyC' }],
      },
      k: {
        type: 'macro',
        play: 'repeat',
        repeat: 1,
        steps: [{ down: 'KeyX' }, { wait: 187 }, { down: 'KeyY' }, { wait: 349 }, { up: 'KeyY' }, { wait: 20 }, { up: 'KeyX' }],
      },
      l: { type: 'emulate', keys: ['KeyZ'], interval: 30 },
      n: { type: 'key', code: 'MouseLeft' },
    }
    for (const [key, action] of Object.entries(expected)) {
      const slot = fnSlot(slots, key)
      expect(slotToAction(slot), key).toEqual(action)
      expect(actionToSlot(slotToAction(slot)), key).toEqual(slot)
    }
  })

  it('round-trips the 3-packet recorded macro (STEP3e)', () => {
    const slot = fnSlot(decodeSlots(capturedReads('STEP3e')), 'k')
    expect(slot.kind === 'macro' && slot.events.length).toBe(40)
    const action = slotToAction(slot)
    expect(action.type === 'macro' && action.steps.slice(0, 3)).toEqual([{ down: 'KeyA' }, { wait: 22 }, { up: 'KeyA' }])
    expect(actionToSlot(action)).toEqual(slot)
    // ...and through the JSON form.
    const profile = tableToProfile({ base: [...FACTORY.base], fn: FACTORY.fn.map((s, i) => (i === 54 ? slot : s)) })
    const reparsed = parseProfileJson(serializeProfile(profile))
    expect(errors(reparsed.issues)).toEqual([])
    expect(profileToTable(reparsed.profile!).fn[54]).toEqual(slot)
  })

  it('compiles every action kind', () => {
    expect(actionToSlot({ type: 'key', code: 'MouseDoubleClick' })).toEqual({ kind: 'codes', codes: [130, 130] })
    expect(slotToAction({ kind: 'codes', codes: [130, 130] })).toEqual({ type: 'key', code: 'MouseDoubleClick' })
    expect(actionToSlot({ type: 'key', code: 161 })).toEqual({ kind: 'codes', codes: [161] })
    expect(slotToAction({ kind: 'codes', codes: [161] })).toEqual({ type: 'key', code: 161 })
    const hold: Action = { type: 'macro', play: 'hold', interval: 30, steps: [{ tap: 'KeyX' }] }
    expect(actionToSlot(hold)).toEqual({
      kind: 'macro',
      playMode: 1,
      cycles: 0,
      hasDelays: false,
      autoDelay: 30,
      events: [57, 57],
      delays: [],
    })
    expect(slotToAction(actionToSlot(hold))).toEqual(hold)
    const toggle: Action = { type: 'macro', play: 'toggle', steps: [{ down: 'KeyX' }, { wait: 0 }, { down: 'KeyY' }] }
    expect(actionToSlot(toggle)).toMatchObject({ playMode: 2, hasDelays: true, events: [57, 34], delays: [0] })
    expect(slotToAction(actionToSlot(toggle))).toEqual(toggle)
    // A recorded tap is a press, 0 ms, release.
    expect(actionToSlot({ type: 'macro', play: 'repeat', repeat: 1, steps: [{ tap: 'KeyA' }, { wait: 5 }, { tap: 'KeyB' }] }))
      .toMatchObject({ events: [43, 43, 60, 60], delays: [0, 5, 0] })
    // Consecutive waits add up; leading and trailing waits have no wire form.
    expect(
      actionToSlot({ type: 'macro', play: 'repeat', repeat: 1, steps: [{ wait: 9 }, { down: 'KeyA' }, { wait: 1 }, { wait: 2 }, { up: 'KeyA' }, { wait: 9 }] }),
    ).toMatchObject({ events: [43, 43], delays: [3] })
    const raw: Action = { type: 'raw', packets: ['00F0'.padEnd(128, '7')] }
    expect(slotToAction(actionToSlot(raw))).toEqual(raw)
    expect(slotToAction({ kind: 'emulate', value: 30, codes: [] })).toEqual({ type: 'none' })
  })
})

describe('normalizeProfile', () => {
  it('expands shorthands, canonicalizes codes and fills missing keys', () => {
    const p = mustNormalize({
      format: 'plum-keymap',
      version: 1,
      device: '84EC-S',
      $schema: 'x',
      layers: { base: { caps: 'controlleft', a: 43, fn: 'Fn', esc: null, b: { type: 'key', code: 199 } }, fn: { fn: 'Fn' } },
    })
    expect(p.layers.base.caps).toEqual({ type: 'key', code: 'ControlLeft' })
    expect(p.layers.base.a).toEqual({ type: 'key', code: 'KeyA' })
    expect(p.layers.base.esc).toEqual({ type: 'none' })
    expect(p.layers.base.b).toEqual({ type: 'key', code: 'MouseDoubleClick' })
    expect(p.layers.base.q).toEqual({ type: 'none' }) // inherit defaults to "none"
    expect(Object.keys(p.layers.fn).sort()).toEqual(KEYS.map((k) => k.id).sort())
    expect(p).not.toHaveProperty('$schema')
  })

  it('inherits the factory map', () => {
    const p = mustNormalize(base({ base: { caps: 'ControlLeft' } }))
    const t = profileToTable(p)
    expect(t.fn).toEqual(FACTORY.fn)
    expect(t.base.filter((s, i) => JSON.stringify(s) !== JSON.stringify(FACTORY.base[i]))).toEqual([
      { kind: 'codes', codes: [67] },
    ])
  })

  it('reports top-level problems', () => {
    expect(normalizeProfile(null)).toEqual({ profile: null, issues: [expect.objectContaining({ path: '', severity: 'error' })] })
    const { profile, issues } = normalizeProfile({ format: 'x', version: 2, device: '84', inherit: 'all', layers: { base: [], top: {} }, extra: 1 })
    expect(profile).toBeNull()
    expect(paths(errors(issues)).sort()).toEqual(['/device', '/format', '/inherit', '/layers/base', '/layers/fn', '/layers/top', '/version'])
    expect(paths(warnings(issues))).toEqual(['/extra'])
    expect(paths(errors(normalizeProfile(base({ base: { capslock: 'KeyA' } })).issues))).toEqual(['/layers/base/capslock'])
  })

  it('reports code problems', () => {
    expect(paths(errors(fnAction('Nope').issues))).toEqual(['/layers/fn/h'])
    expect(paths(errors(fnAction(0).issues))).toEqual(['/layers/fn/h'])
    expect(paths(errors(fnAction(256).issues))).toEqual(['/layers/fn/h'])
    expect(paths(errors(fnAction(1.5).issues))).toEqual(['/layers/fn/h'])
    expect(paths(errors(fnAction(true).issues))).toEqual(['/layers/fn/h'])
    expect(paths(errors(fnAction({ type: 'key' }).issues))).toEqual(['/layers/fn/h/code'])
    expect(paths(errors(fnAction({ type: 'bogus' }).issues))).toEqual(['/layers/fn/h/type'])
    const unknown = fnAction(161)
    expect(errors(unknown.issues)).toEqual([])
    expect(paths(warnings(unknown.issues))).toEqual(['/layers/fn/h'])
    expect(unknown.profile!.layers.fn.h).toEqual({ type: 'key', code: 161 })
    expect(paths(warnings(fnAction({ type: 'key', code: 'KeyA', extra: 1 }).issues))).toEqual(['/layers/fn/h/extra'])
  })

  it('checks combos and emulates', () => {
    const combo = (keys: unknown) => paths(errors(fnAction({ type: 'combo', keys }).issues))
    expect(combo(['KeyA', 'KeyB'])).toEqual([])
    expect(combo(['KeyA'])).toEqual(['/layers/fn/h/keys'])
    expect(combo(['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG'])).toEqual(['/layers/fn/h/keys'])
    expect(combo(['KeyA', 43])).toEqual([]) // 43 is KeyA: a repeat (warning, see below)
    expect(paths(warnings(fnAction({ type: 'combo', keys: ['KeyA', 43] }).issues))).toEqual(['/layers/fn/h/keys/1'])
    expect(combo(['KeyA', 'MouseDoubleClick'])).toEqual(['/layers/fn/h/keys/1'])
    expect(combo('KeyA')).toEqual(['/layers/fn/h/keys'])
    // A repeated key is what KB84 itself records and sends ([0, 2, A, A]): a warning, and the bytes are kept.
    const dup = fnAction({ type: 'combo', keys: ['KeyA', 'KeyA'] })
    expect(errors(dup.issues)).toEqual([])
    expect(paths(warnings(dup.issues))).toEqual(['/layers/fn/h/keys/1'])
    const slot = actionToSlot(dup.profile!.layers.fn.h)
    expect(slot).toEqual({ kind: 'codes', codes: [43, 43] })
    const [packet] = encodeSlot(2, keyById('h')!.no, slot)
    expect(Array.from(packet.subarray(0, 8))).toEqual([0x00, 0xf0, 0x02, 0x35, 0x00, 0x02, 0x2b, 0x2b])
    expect(slotToAction(slot)).toEqual({ type: 'combo', keys: ['KeyA', 'KeyA'] })
    const emulate = (keys: unknown, interval: unknown) => paths(errors(fnAction({ type: 'emulate', keys, interval }).issues))
    expect(emulate(['KeyZ'], 30)).toEqual([])
    expect(emulate([], 30)).toEqual(['/layers/fn/h/keys'])
    expect(emulate(['KeyZ'], 6001)).toEqual(['/layers/fn/h/interval'])
    expect(emulate(['KeyZ'], undefined)).toEqual(['/layers/fn/h/interval'])
    expect(emulate(['KeyZ', 199], 0)).toEqual(['/layers/fn/h/keys/1'])
  })

  it('checks macros', () => {
    const macro = (m: object) => fnAction({ type: 'macro', play: 'repeat', repeat: 1, steps: [{ tap: 'KeyA' }], ...m }).issues
    const errs = (m: object) => paths(errors(macro(m)))
    expect(macro({})).toEqual([])
    expect(errs({ play: 'loop' })).toContain('/layers/fn/h/play')
    expect(errs({ repeat: undefined })).toEqual(['/layers/fn/h/repeat'])
    expect(errs({ repeat: 256 })).toEqual(['/layers/fn/h/repeat'])
    expect(errs({ play: 'hold' })).toEqual(['/layers/fn/h/repeat'])
    expect(errs({ play: 'toggle', repeat: undefined })).toEqual([])
    expect(errs({ interval: 60001 })).toEqual(['/layers/fn/h/interval'])
    expect(errs({ steps: [] })).toEqual(['/layers/fn/h/steps'])
    expect(errs({ steps: [{ wait: 5 }] })).toEqual(['/layers/fn/h/steps'])
    expect(errs({ steps: 'KeyA' })).toEqual(['/layers/fn/h/steps'])
    expect(errs({ interval: 10, steps: [{ down: 'KeyA' }, { wait: 5 }, { up: 'KeyA' }] })).toEqual(['/layers/fn/h/steps/1'])
    expect(errs({ steps: [{ down: 'KeyA' }, { wait: 65536 }, { up: 'KeyA' }] })).toEqual(['/layers/fn/h/steps/1'])
    expect(errs({ steps: [{ down: 'KeyA' }, { wait: 65535 }, { wait: 1 }, { up: 'KeyA' }] })).toEqual(['/layers/fn/h/steps/2'])
    expect(errs({ steps: [{ tap: 'KeyA', down: 'KeyB' }] })).toEqual(['/layers/fn/h/steps/0'])
    expect(errs({ steps: [{ press: 'KeyA' }] })).toEqual(['/layers/fn/h/steps/0'])
    expect(errs({ steps: [{ tap: 'KeyA' }, { tap: 'Nope' }] })).toEqual(['/layers/fn/h/steps/1'])
    // Toggle semantics.
    expect(errs({ steps: [{ down: 'KeyA' }, { down: 'KeyA' }] })).toEqual(['/layers/fn/h/steps/1'])
    expect(errs({ steps: [{ down: 'KeyA' }, { tap: 'KeyA' }, { up: 'KeyA' }] })).toEqual(['/layers/fn/h/steps/1'])
    expect(errs({ steps: [{ tap: 'KeyA' }, { up: 'KeyA' }] })).toEqual(['/layers/fn/h/steps/1'])
    const held = macro({ steps: [{ down: 'ShiftLeft' }, { tap: 'KeyA' }] })
    expect(errors(held)).toEqual([])
    expect(warnings(held)).toEqual([expect.objectContaining({ path: '/layers/fn/h/steps', message: expect.stringContaining('ShiftLeft') })])
    expect(paths(warnings(macro({ steps: [{ wait: 3 }, { tap: 'KeyA' }, { wait: 3 }] })))).toEqual([
      '/layers/fn/h/steps/0',
      '/layers/fn/h/steps/2',
    ])
    // Forbidden codes.
    expect(errs({ steps: [{ tap: 'MouseDoubleClick' }] })).toEqual(['/layers/fn/h/steps/0'])
    expect(errs({ steps: [{ tap: 'KeyA' }, { tap: 200 }] })).toEqual(['/layers/fn/h/steps/1'])
    expect(errs({ interval: 0, steps: [{ tap: 200 }] })).toEqual([])
    // Size limit: KB84's maxima, 1600 events with a fixed interval and 400 recorded events (1597 bytes).
    const taps = (n: number) => Array.from({ length: n }, () => ({ tap: 'KeyA' }))
    expect(errs({ interval: 0, steps: taps(800) })).toEqual([]) // 1600 bytes
    expect(errs({ interval: 0, steps: [...taps(800), { down: 'KeyB' }] })).toEqual(['/layers/fn/h/steps']) // 1601 bytes
    expect(errs({ steps: taps(200) })).toEqual([]) // 400 events: 1597 bytes
    expect(errs({ steps: [...taps(200), { down: 'KeyB' }] })).toEqual(['/layers/fn/h/steps']) // 1601 bytes
  })

  it('checks raw packets', () => {
    const header = '00F002' + keyById('h')!.no.toString(16).toUpperCase().padStart(2, '0')
    const good = header.padEnd(128, '0')
    expect(fnAction({ type: 'raw', packets: [good.toLowerCase().replace(/(..)/g, '$1 ')] }).issues).toEqual([])
    expect(fnAction({ type: 'raw', packets: [good] }).profile!.layers.fn.h).toEqual({ type: 'raw', packets: [good] })
    expect(paths(errors(fnAction({ type: 'raw', packets: [good.slice(2)] }).issues))).toEqual(['/layers/fn/h/packets/0'])
    expect(paths(errors(fnAction({ type: 'raw', packets: [] }).issues))).toEqual(['/layers/fn/h/packets'])
    // Raw packets are sent verbatim: a header for another slot (or no slot header at all) is an error.
    expect(paths(errors(fnAction({ type: 'raw', packets: [good, '00F00101'.padEnd(128, '0')] }).issues))).toEqual([
      '/layers/fn/h/packets/1',
    ])
    expect(paths(errors(fnAction({ type: 'raw', packets: ['00F10235'.padEnd(128, '0')] }).issues))).toEqual([
      '/layers/fn/h/packets/0',
    ])
    // Framing: as many packets as the first one announces (ceil(len/53) for a macro), all with the same 11-byte header.
    const macroHead = (len: number) => `${header}0201010000${len.toString(16).padStart(4, '0').toUpperCase()}`
    const two = [macroHead(54).padEnd(128, '1'), macroHead(54).padEnd(128, '2')]
    expect(fnAction({ type: 'raw', packets: two }).issues).toEqual([])
    expect(errors(fnAction({ type: 'raw', packets: two.slice(0, 1) }).issues)).toEqual([
      expect.objectContaining({ path: '/layers/fn/h/packets', message: expect.stringMatching(/^The first packet announces 2 packet\(s\), got 1/) }),
    ])
    expect(paths(errors(fnAction({ type: 'raw', packets: [two[0], macroHead(55).padEnd(128, '2')] }).issues))).toEqual([
      '/layers/fn/h/packets',
    ])
    expect(paths(errors(fnAction({ type: 'raw', packets: [good, good] }).issues))).toEqual(['/layers/fn/h/packets'])
    expect(normalizeActionInput({ type: 'raw', packets: ['00F00101'.padEnd(128, '0')] }).issues).toEqual([])
    expect(paths(normalizeActionInput({ type: 'raw', packets: ['01F00101'.padEnd(128, '0')] }, '/x').issues)).toEqual(['/x/packets/0'])
  })

  it('applies the Fn rules', () => {
    const noFn = normalizeProfile(base({ base: { fn: 'KeyA' }, fn: { fn: null } }))
    expect(errors(noFn.issues)).toEqual([])
    expect(paths(warnings(noFn.issues))).toEqual(['/layers/base'])
    const oneSided = normalizeProfile(base({ fn: { fn: null, rctrl: 'Fn' } }))
    expect(paths(warnings(oneSided.issues)).sort()).toEqual(['/layers/base/fn', '/layers/fn/rctrl'])
    expect(warnings(normalizeProfile(base()).issues)).toEqual([])
  })

  it('normalizes the library and backlight', () => {
    const p = mustNormalize(
      base({}, { library: { combos: [{ name: 'Task manager', action: { type: 'combo', keys: ['ControlLeft', 'ShiftLeft', 1] } }] }, backlight: { '1': '#FF0000' } }),
    )
    expect(p.library).toEqual({ combos: [{ name: 'Task manager', action: { type: 'combo', keys: ['ControlLeft', 'ShiftLeft', 'Escape'] } }] })
    expect(p.backlight).toEqual({ '1': '#ff0000' })
    expect(paths(errors(normalizeProfile(base({}, { library: { macros: [{ name: 'x', action: [] }, {}] } })).issues))).toEqual([
      '/library/macros/0/action',
      '/library/macros/1',
    ])
  })

  it('never throws', () => {
    const junk: unknown[] = [undefined, 0, 'x', [], { layers: null }, base({ base: { a: [] } }), base({ fn: { h: { type: 'macro', steps: [null, 1, [], { wait: 'x' }] } } })]
    for (const j of junk) expect(() => normalizeProfile(j)).not.toThrow()
    expect(parseProfileJson('{ nope')).toEqual({ profile: null, issues: [expect.objectContaining({ path: '', severity: 'error' })] })
    expect(normalizeActionInput('KeyA')).toEqual({ action: { type: 'key', code: 'KeyA' }, issues: [] })
    expect(normalizeActionInput({ type: 'combo', keys: ['KeyA'] }, '/x').issues).toEqual([expect.objectContaining({ path: '/x/keys' })])
  })
})

describe('serializeProfile', () => {
  const factoryProfile = tableToProfile(FACTORY, FACTORY_META)
  const demoProfile = () => mustNormalize(readJson(DEMO_EXAMPLE))

  it('writes shorthands in layout order and re-parses to the same profile', () => {
    const text = serializeProfile(factoryProfile)
    expect(text).toContain('"$schema": "../format/plum-keymap.schema.json"')
    expect(text).toContain('      "caps": "CapsLock",\n')
    expect(text).toContain('      "h": null,\n')
    const baseKeys = [...text.split('"fn": {')[0].matchAll(/^ {6}"([^"]+)":/gm)].map((m) => m[1])
    expect(baseKeys).toEqual(KEYS.map((k) => k.id))
    expect(mustNormalize(JSON.parse(text))).toEqual(factoryProfile)
  })

  it('writes only the differences with style diff-factory', () => {
    const demo = demoProfile()
    const text = serializeProfile(demo, { style: 'diff-factory' })
    const json = JSON.parse(text) as { inherit: string; layers: Record<string, object> }
    expect(json.inherit).toBe('factory')
    expect(Object.keys(json.layers.base)).toEqual(['caps', 'lctrl'])
    expect(mustNormalize(json)).toEqual(demo)
    expect(mustNormalize(JSON.parse(serializeProfile(demo)))).toEqual(demo)
    expect(serializeProfile(tableToProfile(FACTORY), { style: 'diff-factory', schemaUrl: null })).toContain(
      '"layers": {\n    "base": {},\n    "fn": {}\n  }',
    )
  })

  it('round-trips every action kind, the library and backlight', () => {
    const profile = mustNormalize(
      base(
        {
          base: { a: 161, b: { type: 'raw', packets: ['00F00142'.padEnd(128, '0')] } },
          fn: { h: { type: 'macro', play: 'toggle', steps: [{ down: 'KeyA' }, { wait: 10 }, { up: 'KeyA' }] } },
        },
        {
          name: 'All "kinds"',
          description: '中文 / English',
          library: { macros: [{ name: 'm', action: { type: 'macro', play: 'hold', interval: 5, steps: [{ tap: 'KeyA' }] } }], emulates: [] },
          backlight: { '1': '#00ff00' },
        },
      ),
    )
    for (const style of ['full', 'diff-factory'] as const) {
      expect(mustNormalize(JSON.parse(serializeProfile(profile, { style })))).toEqual(profile)
    }
  })
})

describe('examples and schema', () => {
  const schema = readJson(SCHEMA_PATH) as { $defs: { codeId: { enum: string[] }; layer: { properties: object } } }
  // Default strict mode: any warning ajv logs about the schema (e.g. strictTypes) fails the test.
  const ajvWarnings: unknown[] = []
  const ajv = new Ajv2020({ allErrors: true, logger: { log() {}, warn: (...a: unknown[]) => ajvWarnings.push(a), error() {} } })
  const validate = ajv.compile(schema)

  it('the schema file is generated from the code and key tables (UPDATE_EXAMPLES=1 rewrites it)', () => {
    if (process.env.UPDATE_EXAMPLES) writeFileSync(new URL(SCHEMA_PATH, ROOT), schemaText())
    expect(readText(SCHEMA_PATH).replace(/\r\n/g, '\n')).toBe(schemaText())
    expect(schema.$defs.codeId.enum).toEqual(CODES.map((c) => c.id))
    // Integer-like ids ("1") sort first in a JS object, so compare as sets.
    expect(Object.keys(schema.$defs.layer.properties).sort()).toEqual(KEYS.map((k) => k.id).sort())
    expect(ajvWarnings).toEqual([])
  })

  it('the examples are up to date (UPDATE_EXAMPLES=1 rewrites them)', () => {
    const factoryText = serializeProfile(tableToProfile(FACTORY, FACTORY_META), { schemaUrl: EXAMPLE_SCHEMA_URL })
    const demoText = serializeProfile(mustNormalize(readJson(DEMO_EXAMPLE)), {
      style: 'diff-factory',
      schemaUrl: EXAMPLE_SCHEMA_URL,
    })
    if (process.env.UPDATE_EXAMPLES) {
      writeFileSync(new URL(FACTORY_EXAMPLE, ROOT), factoryText)
      writeFileSync(new URL(DEMO_EXAMPLE, ROOT), demoText)
    }
    expect(readText(FACTORY_EXAMPLE).replace(/\r\n/g, '\n')).toBe(factoryText)
    expect(readText(DEMO_EXAMPLE).replace(/\r\n/g, '\n')).toBe(demoText)
  })

  it('validates both examples', () => {
    for (const path of [FACTORY_EXAMPLE, DEMO_EXAMPLE]) {
      expect(validate(readJson(path)), `${path}: ${ajv.errorsText(validate.errors)}`).toBe(true)
    }
  })

  it('the factory example equals FACTORY', () => {
    const p = mustNormalize(readJson(FACTORY_EXAMPLE))
    expect(profileToTable(p)).toEqual(FACTORY)
  })

  it('the demo compiles without issues', () => {
    const { profile, issues } = normalizeProfile(readJson(DEMO_EXAMPLE))
    expect(issues).toEqual([])
    const t: SlotTable = profileToTable(profile!)
    const no = (id: string) => keyById(id)!.no - 1
    expect(t.base[no('caps')]).toEqual({ kind: 'codes', codes: [67] })
    expect(t.fn[no('h')]).toEqual({ kind: 'codes', codes: [67, 55, 1] })
    expect(t.fn[no('j')]).toEqual(fnSlot(decodeSlots(capturedReads('STEP3c')), 'j'))
    expect(t.fn[no('l')]).toEqual(fnSlot(decodeSlots(capturedReads('STEP3c')), 'l'))
    expect(t.fn[no('m')]).toEqual({ kind: 'codes', codes: [130, 130] })
    expect(t.fn[no('k')]).toMatchObject({ kind: 'macro', hasDelays: true, events: [55, 48, 48, 55, 36, 36, 54, 54], delays: [120, 0, 80, 40, 0, 250, 0] })
    for (const layer of LAYERS) expect(t[layer]).toHaveLength(84)
  })

  it('rejects bad inputs', () => {
    const bad: unknown[] = [
      {},
      { ...base(), format: 'other' },
      { ...base(), version: 2 },
      base({ base: { capslock: 'KeyA' } }),
      base({ base: { caps: 'NotACode' } }),
      base({ base: { caps: 0 } }),
      base({ base: { caps: 256 } }),
      base({ fn: { h: { type: 'combo', keys: ['KeyA'] } } }),
      base({ fn: { h: { type: 'combo', keys: ['KeyA', 'MouseDoubleClick'] } } }),
      base({ fn: { h: { type: 'emulate', keys: ['KeyA'], interval: 6001 } } }),
      base({ fn: { h: { type: 'macro', play: 'repeat', steps: [{ tap: 'KeyA' }] } } }),
      base({ fn: { h: { type: 'macro', play: 'hold', repeat: 1, steps: [{ tap: 'KeyA' }] } } }),
      base({ fn: { h: { type: 'macro', play: 'hold', interval: 5, steps: [{ tap: 'KeyA' }, { wait: 5 }] } } }),
      base({ fn: { h: { type: 'macro', play: 'hold', steps: [] } } }),
      base({ fn: { h: { type: 'macro', play: 'hold', steps: [{ press: 'KeyA' }] } } }),
      base({ fn: { h: { type: 'raw', packets: ['00F0'] } } }),
      base({}, { backlight: { '1': 'red' } }),
      base({}, { backlight: { nokey: '#ff0000' } }),
      base({ fn: { h: { type: 'raw', packets: ['00F10235'.padEnd(128, '0')] } } }),
      base({}, { library: { combos: [{ name: 'x', action: { type: 'emulate', keys: ['KeyA'], interval: 1 } }] } }),
      base({}, { library: { combos: [{ name: 'x', action: 'KeyA' }] } }),
    ]
    for (const input of bad) {
      expect(validate(input), JSON.stringify(input)).toBe(false)
      expect(normalizeProfile(input).profile, JSON.stringify(input)).toBeNull()
    }
  })
})

// --- golden write streams ---------------------------------------------------------------------------------------

/** The 64-byte payloads of every key write (00 F1 … 00 F6) KB84 sent during the given step. */
function capturedWrites(step: string): Uint8Array[] {
  let current = ''
  let seq: Uint8Array[] | null = null
  for (const line of readText('docs/re/live-capture.jsonl').split(/\r?\n/)) {
    if (!line) continue
    const e = JSON.parse(line) as CaptureEvent
    if (e.kind === 'marker') current = e.text!.split(' ')[0]
    if (current !== step || e.kind !== 'W' || !e.data) continue
    const p = Uint8Array.from(e.data.match(/../g)!, (b) => parseInt(b, 16)).subarray(1)
    if (p[1] === 0xf1) seq = [p]
    else if (seq) {
      seq.push(p)
      if (p[1] === 0xf6) return seq
    }
  }
  throw new Error(`no write sequence in ${step}`)
}

/** Slot table of a captured write sequence, via the protocol codec. */
function writeTable(seq: Uint8Array[], rawSlots = 0): SlotTable {
  const asm = new ReadAssembler()
  for (const p of seq.slice(1, -1)) asm.accept(p)
  asm.accept(readEnd())
  const r = asm.result()
  expect(r.warnings).toHaveLength(rawSlots)
  return r.table
}

const validateExample = new Ajv2020({ allErrors: true }).compile(readJson(SCHEMA_PATH) as object)

const hex = (packets: Uint8Array[]) => packets.map((p) => Array.from(p, (b) => b.toString(16).padStart(2, '0')).join(''))

describe('golden: KB84 write streams from the live capture', () => {
  it('a hand-written profile compiles to the exact bytes KB84 sent for the STEP2 test keys', () => {
    // FORMAT.md section 12, with the repeat count the format requires.
    const profile = mustNormalize(
      base({
        fn: {
          h: { type: 'combo', keys: ['ShiftLeft', 'ControlLeft', 'KeyA'] },
          j: { type: 'macro', play: 'repeat', repeat: 2, interval: 30, steps: [{ tap: 'KeyA' }, { tap: 'KeyB' }, { tap: 'KeyC' }] },
          k: {
            type: 'macro',
            play: 'repeat',
            repeat: 1,
            steps: [{ down: 'KeyX' }, { wait: 187 }, { down: 'KeyY' }, { wait: 349 }, { up: 'KeyY' }, { wait: 20 }, { up: 'KeyX' }],
          },
          l: { type: 'emulate', keys: ['KeyZ'], interval: 30 },
          n: 'MouseLeft',
        },
      }),
    )
    expect(hex(encodeWriteSequence(profileToTable(profile)))).toEqual(hex(capturedWrites('STEP2')))
  })

  it('the factory example compiles to the exact bytes of the config.pro restore (STEP5)', () => {
    const p = mustNormalize(readJson(FACTORY_EXAMPLE))
    expect(hex(encodeWriteSequence(profileToTable(p)))).toEqual(hex(capturedWrites('STEP5')))
  })

  it.each(['STEP2', 'STEP3d', 'STEP5'])('%s: device table -> JSON -> table re-encodes byte-identically', (step) => {
    const seq = capturedWrites(step)
    const table = writeTable(seq)
    for (const style of ['full', 'diff-factory'] as const) {
      const { profile, issues } = parseProfileJson(serializeProfile(tableToProfile(table), { style }))
      expect(errors(issues)).toEqual([])
      expect(hex(encodeWriteSequence(profileToTable(profile!)))).toEqual(hex(seq))
    }
  })

  it('the STEP3d long macro (3 packets) equals what the device returned in STEP3e', () => {
    const written = writeTable(capturedWrites('STEP3d')).fn[keyById('k')!.no - 1]
    expect(written).toEqual(fnSlot(decodeSlots(capturedReads('STEP3e')), 'k'))
    const action = slotToAction(written)
    if (action.type !== 'macro' || written.kind !== 'macro') throw new Error('expected a macro')
    // a..t pressed and released with recorded delays: 40 events, 39 waits (one of 10604 ms), no zero-delay taps.
    expect(action).toMatchObject({ play: 'repeat', repeat: 1 })
    expect(action.steps).toHaveLength(79)
    expect(action.steps.flatMap((s) => ('wait' in s ? [s.wait] : []))).toEqual(written.delays)
    expect(written.delays).toContain(10604)
  })

  it('a slot the codec keeps raw survives the JSON round-trip byte for byte', () => {
    const seq = capturedWrites('STEP2')
    const odd = new Uint8Array(64)
    odd.set([0x00, 0xf0, 0x02, keyById('m')!.no, 0x07, 0x01, 0x2b]) // unknown slot type 7
    const table = writeTable(seq.map((p) => (p[2] === 2 && p[3] === keyById('m')!.no ? odd : p)), 1)
    expect(table.fn[keyById('m')!.no - 1].kind).toBe('raw')
    const { profile, issues } = parseProfileJson(serializeProfile(tableToProfile(table)))
    expect(errors(issues)).toEqual([])
    expect(profile!.layers.fn.m).toEqual({ type: 'raw', packets: [hex([odd])[0].toUpperCase()] })
    expect(hex(encodeSlot(2, keyById('m')!.no, profileToTable(profile!).fn[keyById('m')!.no - 1]))).toEqual(hex([odd]))
  })
})

describe('review fixes', () => {
  it('library entries must match their group (KB84 libraries hold only combos / macros / emulates)', () => {
    const lib = (library: object) => normalizeProfile(base({}, { library }))
    const emulate = { type: 'emulate', keys: ['KeyA'], interval: 1 }
    expect(paths(errors(lib({ combos: [{ name: 'x', action: emulate }] }).issues))).toEqual(['/library/combos/0/action'])
    expect(paths(errors(lib({ macros: [{ name: 'x', action: 'KeyA' }] }).issues))).toEqual(['/library/macros/0/action'])
    expect(paths(errors(lib({ emulates: [{ name: 'x', action: null }] }).issues))).toEqual(['/library/emulates/0/action'])
    const ok = lib({ emulates: [{ name: 'x', action: emulate }] })
    expect(ok.issues).toEqual([])
    // Whatever the normalizer accepts, the schema accepts after serialization.
    expect(validateExample(JSON.parse(serializeProfile(ok.profile!)))).toBe(true)
  })

  it('backlight keys must be physical key ids', () => {
    expect(paths(errors(normalizeProfile(base({}, { backlight: { esc: '#000000', nokey: '#ff0000' } })).issues))).toEqual([
      '/backlight/nokey',
    ])
  })

  it('reports wait overflow only between two events, and warns about every ignored wait', () => {
    const macro = (steps: object[]) => fnAction({ type: 'macro', play: 'hold', steps }).issues
    // Leading waits are dropped, so their sum does not matter.
    const leading = macro([{ wait: 40000 }, { wait: 30000 }, { tap: 'KeyA' }])
    expect(errors(leading)).toEqual([])
    expect(paths(warnings(leading))).toEqual(['/layers/fn/h/steps/0', '/layers/fn/h/steps/1'])
    const trailing = macro([{ tap: 'KeyA' }, { wait: 40000 }, { wait: 30000 }])
    expect(errors(trailing)).toEqual([])
    expect(paths(warnings(trailing))).toEqual(['/layers/fn/h/steps/1', '/layers/fn/h/steps/2'])
    expect(paths(errors(macro([{ tap: 'KeyA' }, { wait: 40000 }, { wait: 30000 }, { wait: 1 }, { tap: 'KeyB' }])))).toEqual([
      '/layers/fn/h/steps/2',
    ])
    // Two separate gaps of 65535 each are fine.
    expect(errors(macro([{ tap: 'KeyA' }, { wait: 65535 }, { tap: 'KeyB' }, { wait: 65535 }, { tap: 'KeyC' }]))).toEqual([])
  })

  it('accepts JSON text with a UTF-8 byte order mark', () => {
    const { profile, issues } = parseProfileJson('﻿' + readText(DEMO_EXAMPLE))
    expect(issues).toEqual([])
    expect(profile).not.toBeNull()
  })
})
