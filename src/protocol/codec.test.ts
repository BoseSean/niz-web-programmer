import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FACTORY } from '../device/layout'
import { SimulatedKeyboard, SimulatorTransport } from '../transport/simulator'
import { KeyboardSession } from './session'
import {
  decodeSlotPackets,
  diffTables,
  encodeSlot,
  encodeWriteSequence,
  lightReadRequest,
  readEnd,
  ReadAssembler,
  readRequest,
  slotsEqual,
  SlotValidationError,
  validateSlot,
  validateSlotAt,
  validateTable,
  versionRequest,
  writeBegin,
  writeEnd,
} from './codec'
import { EMPTY_SLOT, emptyTable, type Slot, type SlotTable } from './slots'

// --- live capture -----------------------------------------------------------------------------------------------

interface CaptureEvent {
  kind: string
  data?: string | number[]
  text?: string
  fn?: string
  layer?: number
  key?: number
}

const capture: CaptureEvent[] = readFileSync(new URL('../../../docs/re/live-capture.jsonl', import.meta.url), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map(l => JSON.parse(l) as CaptureEvent)

/** 64-byte payload of a captured 65-byte report (drops the report id). */
const payload = (hex: string) => Uint8Array.from(hex.match(/../g)!, b => parseInt(b, 16)).subarray(1)
const hex = (p: Uint8Array) => Array.from(p, b => b.toString(16).padStart(2, '0')).join(' ')
const fromHex = (s: string): Uint8Array => {
  const p = new Uint8Array(64)
  p.set(s.trim().split(/\s+/).map(b => parseInt(b, 16)))
  return p
}

/** KB84 HWI int-array form (spec d.5) → Slot. */
function slotFromInts(d: number[]): Slot {
  if (d[0] === 0) return { kind: 'codes', codes: d.slice(2, 2 + d[1]) }
  if (d[0] === 1) return { kind: 'emulate', value: d[1], codes: d.slice(3, 3 + d[2]) }
  const [, playMode, cycles, hasDelays, autoDelay, n] = d
  const items = d.slice(6)
  if (!hasDelays)
    return { kind: 'macro', playMode: playMode as 0, cycles, hasDelays: false, autoDelay, events: items.slice(0, n), delays: [] }
  return {
    kind: 'macro',
    playMode: playMode as 0,
    cycles,
    hasDelays: true,
    autoDelay,
    events: items.filter((_, i) => i % 2 === 0).slice(0, n),
    delays: items.filter((_, i) => i % 2 === 1).slice(0, n - 1),
  }
}

/** Slot -> KB84 HWI int-array form (spec d.5); empty reads back as [0, 0]. */
function slotToInts(s: Slot): number[] {
  switch (s.kind) {
    case 'empty':
      return [0, 0]
    case 'codes':
      return [0, s.codes.length, ...s.codes]
    case 'emulate':
      return [1, s.value, s.codes.length, ...s.codes]
    case 'macro': {
      const items = s.hasDelays ? s.events.flatMap((e, i) => (i ? [s.delays[i - 1], e] : [e])) : s.events
      return [2, s.playMode, s.cycles, s.hasDelays ? 1 : 0, s.autoDelay, s.events.length, ...items]
    }
    case 'raw':
      throw new Error('raw slot in a captured read')
  }
}

interface CapturedWrite {
  step: string
  table: SlotTable
  packets: Uint8Array[]
}
interface CapturedRead {
  step: string
  /** The `00 F2` request KB84 sent. */
  request: Uint8Array
  packets: Uint8Array[]
  /** getKeyConfiguration int arrays KB84 decoded from this read, in call order. */
  getKeys: CaptureEvent[]
}

function parseCapture(): { writes: CapturedWrite[]; reads: CapturedRead[] } {
  const writes: CapturedWrite[] = []
  const reads: CapturedRead[] = []
  let step = ''
  let table = emptyTable()
  let current: { kind: 'W' | 'R'; packets: Uint8Array[] } | null = null
  for (const e of capture) {
    if (e.kind === 'marker') step = e.text!.split(' ')[0]
    else if (e.kind === 'call' && e.fn === 'prepare') table = emptyTable()
    else if (e.kind === 'setKey') (e.layer === 0 ? table.base : table.fn)[e.key! - 1] = slotFromInts(e.data as number[])
    else if (e.kind === 'call' && e.fn === 'writeKeyConfigurationToDev') current = { kind: 'W', packets: [] }
    else if (e.kind === 'call' && e.fn === 'readKeyDefinationFromDev') current = { kind: 'R', packets: [] }
    else if (e.kind === 'ret' && current && (e.fn === 'writeKeyConfigurationToDev' || e.fn === 'readKeyDefinationFromDev')) {
      if (current.kind === 'W') writes.push({ step, table, packets: current.packets })
      else reads.push({ step, request: current.packets[0], packets: current.packets.slice(1), getKeys: [] })
      current = null
    } else if ((e.kind === 'W' || e.kind === 'R') && current) current.packets.push(payload(e.data as string))
    else if (e.kind === 'getKey') reads.at(-1)!.getKeys.push(e)
  }
  return { writes, reads }
}

const { writes, reads } = parseCapture()
const write = (step: string) => writes.find(w => w.step === step)!
const read = (step: string) => reads.find(r => r.step === step)!

function assemble(packets: Uint8Array[]) {
  const asm = new ReadAssembler()
  packets.forEach((p, i) => expect(asm.accept(p)).toBe(i === packets.length - 1 ? 'done' : 'more'))
  return asm.result()
}

function encodeTable(table: SlotTable): Uint8Array[] {
  const out: Uint8Array[] = []
  table.base.forEach((s, i) => out.push(...encodeSlot(1, i + 1, s)))
  table.fn.forEach((s, i) => out.push(...encodeSlot(2, i + 1, s)))
  return out
}

describe('golden: captured writes', () => {
  it('finds the captured operations', () => {
    expect(writes.map(w => w.step)).toEqual(['STEP2', 'STEP3d', 'STEP5'])
    expect(reads.map(r => r.step)).toEqual(['STEP1', 'STEP3a', 'STEP3c', 'STEP3e', 'STEP5b'])
  })

  it.each([
    ['STEP2', 170],
    ['STEP3d', 172],
    ['STEP5', 170],
  ])('%s: encodeWriteSequence reproduces all %i packets byte-for-byte', (step, count) => {
    const w = write(step)
    expect(w.packets).toHaveLength(count)
    const ours = encodeWriteSequence(w.table)
    expect(ours.map(hex)).toEqual(w.packets.map(hex))
  })

  it('STEP3d long macro repeats the 11-byte header in all 3 packets', () => {
    const fnK = encodeSlot(2, 55, write('STEP3d').table.fn[54])
    expect(fnK).toHaveLength(3)
    for (const p of fnK) expect(hex(p.subarray(0, 11))).toBe('00 f0 02 37 02 01 01 00 00 00 9d')
  })

  it('STEP5 restore writes exactly the factory bank', () => {
    expect(diffTables(write('STEP5').table, FACTORY)).toEqual([])
  })
})

describe('golden: captured reads', () => {
  it.each(['STEP1', 'STEP3a', 'STEP3c', 'STEP3e', 'STEP5b'])('%s decodes and re-encodes to the captured packets', step => {
    const { packets } = read(step)
    expect(packets.at(-1)![0]).toBe(0xf6)
    const res = assemble(packets)
    expect(res.warnings).toEqual([])
    expect(res.seen.base.every(Boolean) && res.seen.fn.every(Boolean)).toBe(true)
    expect(res.packetCount).toBe(packets.length - 1)
    expect(encodeTable(res.table).map(hex)).toEqual(packets.slice(0, -1).map(hex))
    expect([...res.table.base, ...res.table.fn].some(s => s.kind === 'raw')).toBe(false)
  })

  it.each(['STEP1', 'STEP3a', 'STEP3c', 'STEP3e', 'STEP5b'])('%s: every slot matches the int array KB84 decoded', step => {
    const r = read(step)
    expect(hex(r.request)).toBe(hex(readRequest()))
    const { table } = assemble(r.packets)
    expect(r.getKeys).toHaveLength(168)
    for (const g of r.getKeys) {
      const ints = slotToInts((g.layer === 0 ? table.base : table.fn)[g.key! - 1])
      // The capture logged at most 64 ints of KB84's buffer, and KB84 leaves stale words behind the ones it fills.
      const got = g.data as number[]
      expect(got.slice(0, ints.length), `${step} L${g.layer} K${g.key}`).toEqual(ints.slice(0, got.length))
    }
  })

  it('Office-mode reads (STEP1, STEP3a) and the restored Program-mode read (STEP5b) equal FACTORY', () => {
    for (const step of ['STEP1', 'STEP3a', 'STEP5b']) expect(diffTables(assemble(read(step).packets).table, FACTORY)).toEqual([])
  })

  it('Program-mode reads return exactly what was written (STEP2 → STEP3c, STEP3d → STEP3e)', () => {
    expect(diffTables(assemble(read('STEP3c').packets).table, write('STEP2').table)).toEqual([])
    expect(diffTables(assemble(read('STEP3e').packets).table, write('STEP3d').table)).toEqual([])
  })

  it('decodes the 3-packet macro to 40 events with the captured delays', () => {
    const slot = assemble(read('STEP3e').packets).table.fn[54]
    const setKey = capture.filter(e => e.kind === 'setKey' && e.layer === 1 && e.key === 55).at(-1)!.data as number[]
    const items = setKey.slice(6)
    expect(slot).toEqual({
      kind: 'macro',
      playMode: 0,
      cycles: 1,
      hasDelays: true,
      autoDelay: 0,
      events: items.filter((_, i) => i % 2 === 0),
      delays: items.filter((_, i) => i % 2 === 1),
    })
    if (slot.kind !== 'macro') throw new Error('not a macro')
    expect(slot.events).toHaveLength(40)
    expect(slot.delays).toHaveLength(39)
    expect(slot.delays).toContain(10604)
  })

  it('decodes the captured emulate and combo slots', () => {
    const t = assemble(read('STEP3c').packets).table
    expect(t.fn[52]).toEqual({ kind: 'codes', codes: [55, 67, 43] })
    expect(t.fn[55]).toEqual({ kind: 'emulate', value: 30, codes: [56] })
    expect(t.fn[66]).toEqual({ kind: 'codes', codes: [130] })
  })
})

// --- encoder unit tests -----------------------------------------------------------------------------------------

describe('commands', () => {
  it('builds 64-byte command payloads', () => {
    expect(hex(readRequest()).startsWith('00 f2 00')).toBe(true)
    expect(hex(writeBegin()).startsWith('00 f1 00')).toBe(true)
    expect(hex(versionRequest()).startsWith('00 f9 00')).toBe(true)
    expect(hex(lightReadRequest()).startsWith('00 e2 00')).toBe(true)
    const end = writeEnd()
    expect(end).toHaveLength(64)
    expect(end[0]).toBe(0)
    expect(end.subarray(1).every(b => b === 0xf6)).toBe(true)
    expect(readEnd().every(b => b === 0xf6)).toBe(true)
    for (const p of [readRequest(), writeBegin(), versionRequest(), lightReadRequest()]) expect(p).toHaveLength(64)
  })
})

describe('encodeSlot (spec d.6 examples)', () => {
  const cases: Array<[string, 1 | 2, number, Slot, string]> = [
    ['empty', 2, 0x54, { kind: 'empty' }, '00 f0 02 54 00 00'],
    ['Esc', 1, 1, { kind: 'codes', codes: [1] }, '00 f0 01 01 00 01 01'],
    ['double click', 1, 1, { kind: 'codes', codes: [130, 130] }, '00 f0 01 01 00 02 82 82'],
    ['combo', 2, 0x35, { kind: 'codes', codes: [55, 67, 43] }, '00 f0 02 35 00 03 37 43 2b'],
    ['emulate', 2, 0x38, { kind: 'emulate', value: 30, codes: [56] }, '00 f0 02 38 01 00 1e 01 38'],
    [
      'macro auto',
      2,
      0x36,
      { kind: 'macro', playMode: 0, cycles: 2, hasDelays: false, autoDelay: 30, events: [43, 43, 60, 60, 58, 58], delays: [] },
      '00 f0 02 36 02 02 00 00 1e 00 06 2b 2b 3c 3c 3a 3a',
    ],
    [
      'macro recorded',
      2,
      0x37,
      { kind: 'macro', playMode: 0, cycles: 1, hasDelays: true, autoDelay: 0, events: [57, 34, 34, 57], delays: [187, 349, 20] },
      '00 f0 02 37 02 01 01 00 00 00 0d 39 c8 00 bb 22 c8 01 5d 22 c8 00 14 39',
    ],
    [
      'hold-play',
      2,
      0x37,
      { kind: 'macro', playMode: 1, cycles: 0, hasDelays: false, autoDelay: 30, events: [57, 57], delays: [] },
      '00 f0 02 37 03 00 00 00 1e 00 02 39 39',
    ],
    [
      'toggle',
      2,
      0x37,
      { kind: 'macro', playMode: 2, cycles: 0, hasDelays: false, autoDelay: 30, events: [57, 57], delays: [] },
      '00 f0 02 37 04 00 00 00 1e 00 02 39 39',
    ],
  ]
  it.each(cases)('%s', (_, layer, key, slot, expected) => {
    const packets = encodeSlot(layer, key, slot)
    expect(packets).toHaveLength(1)
    expect(packets[0]).toHaveLength(64)
    expect(hex(packets[0])).toBe(hex(fromHex(expected)))
    expect(decodeSlotPackets(packets)).toEqual({ layer, keyNo: key, slot, warnings: [] })
  })

  it('splits a 77-byte recorded macro into 2 packets (spec d.6)', () => {
    const events = [43, 43, 60, 60, 58, 58, 45, 45, 31, 31, 46, 46, 47, 47, 48, 48, 36, 36, 49, 49]
    const slot: Slot = { kind: 'macro', playMode: 0, cycles: 1, hasDelays: true, autoDelay: 0, events, delays: Array(19).fill(100) }
    const packets = encodeSlot(2, 0x37, slot)
    expect(packets.map(hex)).toEqual(
      [
        '00 F0 02 37 02 01 01 00 00 00 4D 2B C8 00 64 2B C8 00 64 3C C8 00 64 3C C8 00 64 3A C8 00 64 3A C8 00 64 2D C8 00 64 2D C8 00 64 1F C8 00 64 1F C8 00 64 2E C8 00 64 2E C8 00 64 2F C8 00 64 2F',
        '00 F0 02 37 02 01 01 00 00 00 4D C8 00 64 30 C8 00 64 30 C8 00 64 24 C8 00 64 24 C8 00 64 31 C8 00 64 31',
      ].map(s => hex(fromHex(s))),
    )
    expect(decodeSlotPackets(packets).slot).toEqual(slot)
  })

  it('re-emits raw packets unchanged', () => {
    const p = fromHex('00 f0 01 05 07 01 02 03')
    const out = encodeSlot(1, 5, { kind: 'raw', packets: [p] })
    expect(out.map(hex)).toEqual([hex(p)])
    expect(out[0]).not.toBe(p)
  })

  it('refuses invalid slots and out-of-range positions', () => {
    expect(() => encodeSlot(1, 1, { kind: 'codes', codes: [] })).toThrow(SlotValidationError)
    expect(() => encodeSlot(3 as 1, 1, { kind: 'empty' })).toThrow(RangeError)
    expect(() => encodeSlot(1, 85, { kind: 'empty' })).toThrow(RangeError)
  })
})

describe('validateSlot', () => {
  const macro = (o: Partial<Extract<Slot, { kind: 'macro' }>>): Slot => ({
    kind: 'macro',
    playMode: 0,
    cycles: 1,
    hasDelays: false,
    autoDelay: 30,
    events: [4, 4],
    delays: [],
    ...o,
  })
  it('accepts valid slots', () => {
    expect(validateSlot({ kind: 'empty' })).toEqual([])
    expect(validateSlot({ kind: 'codes', codes: Array(58).fill(4) })).toEqual([])
    expect(validateSlot({ kind: 'emulate', value: 65535, codes: Array(56).fill(4) })).toEqual([])
    expect(validateSlot(macro({}))).toEqual([])
    expect(validateSlot(macro({ playMode: 1, cycles: 0 }))).toEqual([])
    expect(validateSlot(macro({ hasDelays: true, autoDelay: 0, events: [4, 5, 5, 4], delays: [0, 65535, 1] }))).toEqual([])
  })
  it.each<[string, Slot]>([
    ['no codes', { kind: 'codes', codes: [] }],
    ['59 codes', { kind: 'codes', codes: Array(59).fill(4) }],
    ['code 0', { kind: 'codes', codes: [0] }],
    ['code 256', { kind: 'codes', codes: [256] }],
    ['fractional code', { kind: 'codes', codes: [4.5] }],
    ['emulate without codes', { kind: 'emulate', value: 30, codes: [] }],
    ['emulate 57 codes', { kind: 'emulate', value: 30, codes: Array(57).fill(4) }],
    ['emulate value', { kind: 'emulate', value: 65536, codes: [4] }],
    ['macro without events', macro({ events: [] })],
    ['playMode 3', macro({ playMode: 3 as 0 })],
    ['cycles 0 in repeat mode', macro({ cycles: 0 })],
    ['cycles 256', macro({ cycles: 256 })],
    ['autoDelay', macro({ autoDelay: 70000 })],
    ['delays count', macro({ hasDelays: true, events: [4, 4], delays: [] })],
    ['delay range', macro({ hasDelays: true, events: [4, 4], delays: [-1] })],
    ['delays without hasDelays', macro({ delays: [5] })],
    ['C8 event with delays', macro({ hasDelays: true, events: [200, 200], delays: [5] })],
    ['data too long', macro({ events: Array(65536).fill(4) })],
    ['raw packet size', { kind: 'raw', packets: [new Uint8Array(10)] }],
    ['raw without packets', { kind: 'raw', packets: [] }],
  ])('rejects %s', (_, slot) => {
    expect(validateSlot(slot).length).toBeGreaterThan(0)
  })
  it('allows code 200 in an auto-interval macro', () => {
    expect(validateSlot(macro({ events: [200, 200] }))).toEqual([])
  })
})

describe('encodeWriteSequence', () => {
  it('writes begin, 168 slots and end', () => {
    const seq = encodeWriteSequence(emptyTable())
    expect(seq).toHaveLength(170)
    expect(hex(seq[0])).toBe(hex(writeBegin()))
    expect(hex(seq[169])).toBe(hex(writeEnd()))
    expect(hex(seq[84])).toBe(hex(fromHex('00 f0 01 54 00 00')))
    expect(hex(seq[85])).toBe(hex(fromHex('00 f0 02 01 00 00')))
  })
  it('names every invalid slot', () => {
    const t = emptyTable()
    t.base[0] = { kind: 'codes', codes: [] }
    t.fn[53] = { kind: 'emulate', value: -1, codes: [4] }
    let err: unknown
    try {
      encodeWriteSequence(t)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SlotValidationError)
    const v = err as SlotValidationError
    expect(v.issues.map(i => [i.layer, i.keyNo])).toEqual([
      ['base', 1],
      ['fn', 54],
    ])
    expect(v.message).toMatch(/Base layer, key 1 \(Esc\)/)
    expect(v.message).toMatch(/Fn layer, key 54/)
  })
  it('reports holes in a sparse layer instead of silently sending fewer than 168 slots', () => {
    const t = emptyTable()
    t.fn = new Array<Slot>(84)
    t.fn.fill(EMPTY_SLOT, 0, 40)
    t.fn.fill(EMPTY_SLOT, 41)
    expect(validateTable(t)).toEqual([{ layer: 'fn', keyNo: 41, messages: ['missing slot'] }])
    expect(() => encodeWriteSequence(t)).toThrow(/Fn layer, key 41/)
  })

  it('refuses raw slots that would put foreign bytes on the wire', () => {
    const atL1K5 = fromHex('00 f0 01 05 09 01 02 03')
    const raw = (...packets: Uint8Array[]): Slot => ({ kind: 'raw', packets })
    expect(validateSlotAt(1, 5, raw(atL1K5))).toEqual([])
    // a raw slot moved to another key would write L1K5 twice and skip L2K11
    expect(validateSlotAt(2, 11, raw(atL1K5))[0]).toMatch(/L1 K5, not L2 K11/)
    expect(() => encodeSlot(2, 11, raw(atL1K5))).toThrow(SlotValidationError)
    const t = emptyTable()
    t.fn[10] = raw(atL1K5)
    expect(() => encodeWriteSequence(t)).toThrow(/Fn layer, key 11/)
    // a terminator or another command inside a raw slot would end or corrupt the write
    expect(validateSlot(raw(writeEnd())).join()).toMatch(/not a slot packet/)
    expect(validateSlot(raw(fromHex('01 f0 01 05 00 01 04'))).join()).toMatch(/not a slot packet/)
    expect(validateSlot(raw(atL1K5, fromHex('00 f0 01 06 09'))).join()).toMatch(/different layer\/key/)
  })

  it('rejects tables with the wrong number of slots', () => {
    expect(() => encodeWriteSequence({ base: [], fn: emptyTable().fn })).toThrow(SlotValidationError)
  })
})

// --- assembler robustness ---------------------------------------------------------------------------------------

describe('ReadAssembler', () => {
  const longMacro: Slot = {
    kind: 'macro',
    playMode: 0,
    cycles: 1,
    hasDelays: true,
    autoDelay: 0,
    events: Array.from({ length: 20 }, (_, i) => 4 + (i >> 1)),
    delays: Array(19).fill(50),
  }

  it('ignores foreign and out-of-range packets with warnings and reports unseen slots', () => {
    const asm = new ReadAssembler()
    expect(asm.accept(fromHex('00 e6'))).toBe('more')
    expect(asm.accept(fromHex('00 f0 03 01 00 01 04'))).toBe('more')
    expect(asm.accept(fromHex('00 f0 01 55 00 01 04'))).toBe('more')
    expect(asm.accept(fromHex('00 f0 01 02 00 01 04'))).toBe('more')
    expect(asm.accept(readEnd())).toBe('done')
    expect(asm.accept(fromHex('00 f0 01 03 00 01 04'))).toBe('done')
    const r = asm.result()
    expect(r.warnings).toHaveLength(3)
    expect(r.packetCount).toBe(4)
    expect(r.table.base[1]).toEqual({ kind: 'codes', codes: [4] })
    expect(r.seen.base.filter(Boolean)).toHaveLength(1)
    expect(r.seen.base[1]).toBe(true)
    expect(r.table.base[2]).toEqual({ kind: 'empty' })
  })

  it('keeps unknown types, bad markers and zero-length data as raw', () => {
    const bad = [
      fromHex('00 f0 01 01 05 01 04'), // type 5
      fromHex('00 f0 01 02 02 01 01 00 00 00 05 04 c9 00 10 04'), // bad C8 marker
      fromHex('00 f0 01 03 01 00 1e 00'), // emulate n=0
      fromHex('00 f0 01 04 02 01 00 00 1e 00 00'), // macro len 0
      fromHex('00 f0 01 05 00 01 00'), // code 0
      fromHex('00 f0 01 06 00 01 04 99'), // trailing garbage
    ]
    const asm = new ReadAssembler()
    bad.forEach(p => asm.accept(p))
    asm.accept(readEnd())
    const r = asm.result()
    expect(r.warnings).toHaveLength(bad.length)
    bad.forEach((p, i) => {
      expect(r.table.base[i]).toEqual({ kind: 'raw', packets: [p] })
      expect(encodeSlot(1, i + 1, r.table.base[i]).map(hex)).toEqual([hex(p)])
    })
  })

  it('assembles multi-packet macros and flags a header mismatch', () => {
    const packets = encodeSlot(1, 10, longMacro)
    expect(packets).toHaveLength(2)
    const asm = new ReadAssembler()
    packets.forEach(p => asm.accept(p))
    // second macro: first packet, then a packet with a different header
    const other = encodeSlot(1, 11, longMacro)
    const wrong = other[1].slice()
    wrong[5] = 9
    asm.accept(other[0])
    asm.accept(wrong)
    asm.accept(readEnd())
    const r = asm.result()
    expect(r.table.base[9]).toEqual(longMacro)
    // key 11: both packets the device sent for the slot stay together, but a header that is not repeated verbatim
    // is not written back (the firmware's framing of such a slot is unknown)
    expect(r.table.base[10]).toEqual({ kind: 'raw', packets: [other[0], wrong] })
    expect(validateSlot(r.table.base[10]).join()).toMatch(/packet #2 does not repeat the 11-byte macro header/)
    expect(() => encodeSlot(1, 11, r.table.base[10])).toThrow(SlotValidationError)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/different headers/)
    expect(r.seen.base[10]).toBe(true)
  })

  it('keeps a macro interrupted by the next slot as raw and still decodes that slot', () => {
    const packets = encodeSlot(1, 10, longMacro)
    const next: Slot = { kind: 'codes', codes: [4] }
    const asm = new ReadAssembler()
    asm.accept(packets[0])
    asm.accept(encodeSlot(1, 11, next)[0])
    asm.accept(readEnd())
    const r = asm.result()
    expect(r.table.base[9]).toEqual({ kind: 'raw', packets: [packets[0]] })
    expect(r.table.base[10]).toEqual(next)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatch(/incomplete \(1\/2 packets.*cannot be written back/)
    // written back, the first packet would make a KB84-style parser take the next slot's packet as its continuation
    expect(validateSlot(r.table.base[9])).toEqual([expect.stringMatching(/announces 2 packet\(s\), got 1/)])
    expect(() => encodeSlot(1, 10, r.table.base[9])).toThrow(SlotValidationError)
  })

  it('keeps a macro cut off by the end marker as raw', () => {
    const packets = encodeSlot(2, 1, longMacro)
    const asm = new ReadAssembler()
    asm.accept(packets[0])
    asm.accept(readEnd())
    const r = asm.result()
    expect(r.table.fn[0]).toEqual({ kind: 'raw', packets: [packets[0]] })
    expect(r.warnings[0]).toMatch(/incomplete/)
    // written back, a KB84-style parser would take the F6 end packet as the continuation
    expect(() => encodeSlot(2, 1, r.table.fn[0])).toThrow(SlotValidationError)
  })

  it('golden STEP3e: the 3-packet macro is writable raw only when complete', () => {
    const packets = read('STEP3e').packets
    const at = packets.findIndex(p => p[1] === 0xf0 && p[2] === 2 && p[3] === 0x37)
    const macro = packets.slice(at, at + 3)
    expect(macro.map(p => hex(p.subarray(0, 11)))).toEqual(Array(3).fill('00 f0 02 37 02 01 01 00 00 00 9d'))
    expect(validateSlotAt(2, 0x37, { kind: 'raw', packets: macro })).toEqual([])
    expect(validateSlot({ kind: 'raw', packets: macro.slice(0, 2) }).join()).toMatch(/announces 3 packet\(s\), got 2/)
    expect(validateSlot({ kind: 'raw', packets: [...macro, macro[2]] }).join()).toMatch(/announces 3 packet\(s\), got 4/)
    // a type-0 slot is one packet: a second one would be read as another slot
    expect(validateSlot({ kind: 'raw', packets: [packets[0], packets[0]] }).join()).toMatch(/announces 1 packet\(s\), got 2/)

    // The read loses packet 2 of 3: the assembler keeps packets 1 and 3 together as raw (2 of 3 packets), and the
    // table can no longer be written until that key is changed.
    const lossy = [...packets.slice(0, at + 1), ...packets.slice(at + 2)]
    const res = new ReadAssembler()
    lossy.forEach(p => res.accept(p))
    const r = res.result()
    expect(r.table.fn[0x36]).toEqual({ kind: 'raw', packets: [macro[0], macro[2]] })
    expect(() => encodeWriteSequence(r.table)).toThrow(/Fn layer, key 55/)
  })
})

describe('slotsEqual / diffTables', () => {
  it('compares structurally and raw slots by wire bytes', () => {
    const codes: Slot = { kind: 'codes', codes: [4, 5] }
    expect(slotsEqual(codes, { kind: 'codes', codes: [4, 5] })).toBe(true)
    expect(slotsEqual(codes, { kind: 'codes', codes: [5, 4] })).toBe(false)
    expect(slotsEqual(codes, { kind: 'empty' })).toBe(false)
    const raw: Slot = { kind: 'raw', packets: encodeSlot(1, 3, codes) }
    expect(slotsEqual(raw, codes)).toBe(true)
    expect(slotsEqual(codes, raw)).toBe(true)
    expect(slotsEqual(raw, { kind: 'codes', codes: [4] })).toBe(false)
  })

  it('lists differing slots by layer and key', () => {
    const a = emptyTable()
    const b = emptyTable()
    b.fn[9] = { kind: 'codes', codes: [4] }
    expect(diffTables(a, b)).toEqual([{ layer: 'fn', keyNo: 10, a: { kind: 'empty' }, b: { kind: 'codes', codes: [4] } }])
    expect(diffTables(FACTORY, FACTORY)).toEqual([])
  })
})

// --- golden: simulator + session replay the capture -------------------------------------------------------------

describe('golden: session over the simulator replays STEP3d (write) and STEP3e (read-back)', () => {
  it('sends exactly the captured W packets and the simulator answers exactly the captured R packets', async () => {
    const log: Array<['out' | 'in', Uint8Array]> = []
    const transport = new SimulatorTransport(new SimulatedKeyboard({ mode: 'program' }), (d, p) => log.push([d, p]))
    const session = new KeyboardSession(transport, { sleep: () => Promise.resolve() })
    const res = await session.writeAll(write('STEP3d').table)
    expect(res.verified).toBe(true)
    const out = log.filter(([d]) => d === 'out').map(([, p]) => hex(p))
    const inp = log.filter(([d]) => d === 'in').map(([, p]) => hex(p))
    expect(out).toEqual([...write('STEP3d').packets, read('STEP3e').request].map(hex))
    expect(inp).toEqual(read('STEP3e').packets.map(hex))
  })
})
