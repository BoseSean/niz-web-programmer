/**
 * Byte-level codec for the 84EC-S configuration protocol (docs/re/SPEC_DRAFT.en.md sections b–d).
 * Every payload is 64 bytes without the HID report id. Slots are encoded exactly as KB84 does; the live capture
 * (docs/re/live-capture.jsonl) is the golden reference, see codec.test.ts.
 */
import { keyByNo } from '../device/layout'
import { KEY_COUNT, type LayerId } from '../device/types'
import { REPORT_SIZE } from '../transport/types'
import { emptyTable, EMPTY_SLOT, type Slot, type SlotTable } from './slots'

export const CMD = {
  /** One key slot (both directions). */
  SLOT: 0xf0,
  WRITE_BEGIN: 0xf1,
  READ: 0xf2,
  /** End of a key stream: H→D `00 F6×63`, D→H `F6×64`. */
  END: 0xf6,
  VERSION: 0xf9,
  LIGHT_CHUNK: 0xe0,
  LIGHT_BEGIN: 0xe1,
  LIGHT_READ: 0xe2,
  LIGHT_END: 0xe6,
} as const

export const SLOT_COUNT = 168
export const MACRO_HEADER_SIZE = 11
/** Macro stream bytes carried by each packet (64 − 11-byte header). */
export const MACRO_CHUNK_SIZE = REPORT_SIZE - MACRO_HEADER_SIZE
export const DELAY_MARKER = 0xc8
export const MAX_TYPE0_CODES = REPORT_SIZE - 6
export const MAX_EMULATE_CODES = REPORT_SIZE - 8
export const MAX_MACRO_DATA = 0xffff

export type WireLayer = 1 | 2

const LAYER_OF_WIRE: Record<WireLayer, LayerId> = { 1: 'base', 2: 'fn' }
const WIRE_OF_LAYER: Record<LayerId, WireLayer> = { base: 1, fn: 2 }

function command(cmd: number): Uint8Array {
  const p = new Uint8Array(REPORT_SIZE)
  p[1] = cmd
  return p
}

export const readRequest = (): Uint8Array => command(CMD.READ)
export const writeBegin = (): Uint8Array => command(CMD.WRITE_BEGIN)
export const versionRequest = (): Uint8Array => command(CMD.VERSION)
export const lightReadRequest = (): Uint8Array => command(CMD.LIGHT_READ)

/** `00 F6 F6 … F6` (63 × F6). */
export function writeEnd(): Uint8Array {
  const p = new Uint8Array(REPORT_SIZE).fill(CMD.END)
  p[0] = 0
  return p
}

/** `F6 × 64`, the device's end-of-read marker. */
export function readEnd(): Uint8Array {
  return new Uint8Array(REPORT_SIZE).fill(CMD.END)
}

// --- validation -------------------------------------------------------------------------------------------------

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

const isInt = (v: unknown, min: number, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

function checkCodes(codes: unknown, max: number, what: string, out: string[]): void {
  if (!Array.isArray(codes)) {
    out.push(`${what}: codes must be an array`)
    return
  }
  if (codes.length < 1 || codes.length > max)
    out.push(`${what}: needs ${max === Infinity ? 'at least 1' : `1..${max}`} codes, got ${codes.length}`)
  codes.forEach((c, i) => {
    if (!isInt(c, 1, 255)) out.push(`${what}: code #${i + 1} (${String(c)}) is not in 1..255`)
  })
}

/** Byte length of a macro's data stream. */
export function macroDataLength(slot: Extract<Slot, { kind: 'macro' }>): number {
  const n = slot.events.length
  return slot.hasDelays ? Math.max(0, 4 * n - 3) : n
}

/**
 * Framing of a raw slot's packets (each already a 64-byte `00 F0 L K` packet). KB84's reader takes
 * `ceil(len/53) − 1` continuation packets after a macro's first packet without checking them (KB84HWI 0x100017b0–
 * 0x100017fe, REA ev_2b119a46…); if the firmware's write parser counts the same way, a raw macro with missing
 * packets would swallow the next slots or the F6 end packet. So a raw slot must hold exactly as many packets as its
 * first packet announces (1 for types 0, 1 and > 4), and a macro's packets must repeat the same 11-byte header.
 */
export function rawFramingProblems(packets: readonly Uint8Array[]): string[] {
  const first = packets[0]
  const want = expectedPacketCount(first)
  if (packets.length !== want)
    return [`raw: the first packet announces ${want} packet(s), got ${packets.length} (an incomplete macro cannot be written back)`]
  const type = first[4]
  if (type >= 2 && type <= 4) {
    const header = first.subarray(0, MACRO_HEADER_SIZE)
    const bad = packets.findIndex(q => !bytesEqual(q.subarray(0, MACRO_HEADER_SIZE), header))
    if (bad > 0) return [`raw: packet #${bad + 1} does not repeat the 11-byte macro header of packet #1`]
  }
  return []
}

/** Wire-level checks (spec section i). Returns human-readable problems; [] means the slot can be sent. */
export function validateSlot(slot: Slot): string[] {
  const out: string[] = []
  switch (slot.kind) {
    case 'empty':
      break
    case 'codes':
      checkCodes(slot.codes, MAX_TYPE0_CODES, 'key/combo', out)
      break
    case 'emulate':
      checkCodes(slot.codes, MAX_EMULATE_CODES, 'emulate', out)
      if (!isInt(slot.value, 0, 0xffff)) out.push(`emulate: value ${slot.value} is not in 0..65535`)
      break
    case 'macro': {
      checkCodes(slot.events, Infinity, 'macro', out)
      if (!isInt(slot.playMode, 0, 2)) out.push(`macro: playMode ${slot.playMode} is not 0, 1 or 2`)
      if (!isInt(slot.cycles, slot.playMode === 0 ? 1 : 0, 255))
        out.push(`macro: cycles ${slot.cycles} is not in ${slot.playMode === 0 ? 1 : 0}..255`)
      if (!isInt(slot.autoDelay, 0, 0xffff)) out.push(`macro: autoDelay ${slot.autoDelay} is not in 0..65535`)
      if (typeof slot.hasDelays !== 'boolean') out.push('macro: hasDelays must be a boolean')
      const delays = Array.isArray(slot.delays) ? slot.delays : []
      if (slot.hasDelays) {
        const want = Math.max(0, (slot.events?.length ?? 0) - 1)
        if (delays.length !== want) out.push(`macro: needs ${want} delays (events − 1), got ${delays.length}`)
        delays.forEach((d, i) => {
          if (!isInt(d, 0, 0xffff)) out.push(`macro: delay #${i + 1} (${String(d)}) is not in 0..65535`)
        })
        if (slot.events?.includes(DELAY_MARKER))
          out.push(`macro: code ${DELAY_MARKER} (0xC8) cannot be used in a macro with recorded delays`)
      } else if (delays.length) out.push('macro: delays must be empty when hasDelays is false')
      if (Array.isArray(slot.events) && macroDataLength(slot) > MAX_MACRO_DATA)
        out.push(`macro: data is ${macroDataLength(slot)} bytes, more than ${MAX_MACRO_DATA}`)
      break
    }
    case 'raw':
      if (!Array.isArray(slot.packets) || slot.packets.length === 0) out.push('raw: needs at least one packet')
      else {
        slot.packets.forEach((p, i) => {
          if (!(p instanceof Uint8Array) || p.length !== REPORT_SIZE) out.push(`raw: packet #${i + 1} is not 64 bytes`)
          // Raw bytes go to the wire verbatim: anything but a slot packet (e.g. `00 F6…`) would corrupt the write.
          else if (p[0] !== 0 || p[1] !== CMD.SLOT) out.push(`raw: packet #${i + 1} is not a slot packet (00 F0 …)`)
          else if (p[2] !== slot.packets[0][2] || p[3] !== slot.packets[0][3])
            out.push(`raw: packet #${i + 1} names a different layer/key than packet #1`)
        })
        if (!out.length) out.push(...rawFramingProblems(slot.packets))
      }
      break
    default:
      out.push(`unknown slot kind ${(slot as { kind?: unknown }).kind as string}`)
  }
  return out
}

/**
 * validateSlot plus the position check for raw slots: their packets are sent verbatim, so they must name the
 * (layer, key) they are written to, or the write would set another key twice and leave this one out.
 */
export function validateSlotAt(layer: WireLayer, keyNo: number, slot: Slot): string[] {
  const out = validateSlot(slot)
  if (slot.kind === 'raw' && !out.length) {
    const [l, k] = [slot.packets[0][2], slot.packets[0][3]]
    if (l !== layer || k !== keyNo) out.push(`raw: packets are for L${l} K${k}, not L${layer} K${keyNo}`)
  }
  return out
}

function slotName(layer: WireLayer, keyNo: number): string {
  const key = keyByNo(keyNo)
  return `${layer === 1 ? 'Base' : 'Fn'} layer, key ${keyNo}${key ? ` (${key.label || key.id})` : ''}`
}

export interface SlotIssue {
  layer: LayerId
  keyNo: number
  messages: string[]
}

export class SlotValidationError extends Error {
  readonly issues: SlotIssue[]
  constructor(issues: SlotIssue[]) {
    super(
      'Invalid key slots:\n' +
        issues.map(i => `${slotName(i.layer === 'base' ? 1 : 2, i.keyNo)}: ${i.messages.join('; ')}`).join('\n'),
    )
    this.name = 'SlotValidationError'
    this.issues = issues
  }
}

/** Validates a whole table (both layers must hold exactly 84 slots). */
export function validateTable(table: SlotTable): SlotIssue[] {
  const issues: SlotIssue[] = []
  for (const layer of ['base', 'fn'] as const) {
    const slots = table[layer]
    if (!Array.isArray(slots) || slots.length !== KEY_COUNT) {
      issues.push({ layer, keyNo: 0, messages: [`layer must hold ${KEY_COUNT} slots`] })
      continue
    }
    // Index loop, not forEach: a sparse array's holes must be reported, not skipped (that would send < 168 slots).
    for (let i = 0; i < KEY_COUNT; i++) {
      const slot = slots[i]
      const messages = slot ? validateSlotAt(WIRE_OF_LAYER[layer], i + 1, slot) : ['missing slot']
      if (messages.length) issues.push({ layer, keyNo: i + 1, messages })
    }
  }
  return issues
}

// --- encoding ---------------------------------------------------------------------------------------------------

function slotPacket(layer: WireLayer, keyNo: number, body: number[]): Uint8Array {
  const p = new Uint8Array(REPORT_SIZE)
  p.set([0x00, CMD.SLOT, layer, keyNo, ...body])
  return p
}

/** Serialized macro stream: events, or `c1 (C8 dHi dLo c2) …` with recorded delays. */
function macroData(slot: Extract<Slot, { kind: 'macro' }>): number[] {
  if (!slot.hasDelays) return [...slot.events]
  const out: number[] = [slot.events[0]]
  for (let i = 1; i < slot.events.length; i++) {
    const d = slot.delays[i - 1]
    out.push(DELAY_MARKER, d >> 8, d & 0xff, slot.events[i])
  }
  return out
}

/**
 * Packets for one slot. Throws when the slot fails validateSlot (so a bad model can never reach the wire).
 * Raw slots are re-emitted byte-for-byte (copies).
 */
export function encodeSlot(layer: WireLayer, keyNo: number, slot: Slot): Uint8Array[] {
  if (layer !== 1 && layer !== 2) throw new RangeError(`layer must be 1 or 2, got ${String(layer)}`)
  if (!isInt(keyNo, 1, KEY_COUNT)) throw new RangeError(`key number must be 1..${KEY_COUNT}, got ${keyNo}`)
  const problems = validateSlotAt(layer, keyNo, slot)
  if (problems.length) throw new SlotValidationError([{ layer: LAYER_OF_WIRE[layer], keyNo, messages: problems }])

  switch (slot.kind) {
    case 'empty':
      return [slotPacket(layer, keyNo, [0, 0])]
    case 'codes':
      return [slotPacket(layer, keyNo, [0, slot.codes.length, ...slot.codes])]
    case 'emulate':
      return [slotPacket(layer, keyNo, [1, slot.value >> 8, slot.value & 0xff, slot.codes.length, ...slot.codes])]
    case 'raw':
      return slot.packets.map(p => p.slice())
    case 'macro': {
      const data = macroData(slot)
      const header = [
        2 + slot.playMode,
        slot.cycles,
        slot.hasDelays ? 1 : 0,
        slot.autoDelay >> 8,
        slot.autoDelay & 0xff,
        data.length >> 8,
        data.length & 0xff,
      ]
      const packets: Uint8Array[] = []
      for (let off = 0; off < data.length; off += MACRO_CHUNK_SIZE)
        packets.push(slotPacket(layer, keyNo, [...header, ...data.slice(off, off + MACRO_CHUNK_SIZE)]))
      return packets
    }
  }
}

/** Full key write: begin, L1K1..84, L2K1..84, end. Throws SlotValidationError naming every bad slot. */
export function encodeWriteSequence(table: SlotTable): Uint8Array[] {
  const issues = validateTable(table)
  if (issues.length) throw new SlotValidationError(issues)
  const out = [writeBegin()]
  for (const [layer, slots] of [[1, table.base], [2, table.fn]] as const)
    slots.forEach((slot, i) => out.push(...encodeSlot(layer, i + 1, slot)))
  out.push(writeEnd())
  return out
}

// --- decoding ---------------------------------------------------------------------------------------------------

export function packetsEqual(a: readonly Uint8Array[], b: readonly Uint8Array[]): boolean {
  return a.length === b.length && a.every((p, i) => bytesEqual(p, b[i]))
}

/** Number of packets a slot occupies, judged from its first packet (1 for types 0/1, ceil(len/53) for macros). */
export function expectedPacketCount(first: Uint8Array): number {
  const type = first[4]
  if (type < 2 || type > 4) return 1
  const len = (first[9] << 8) | first[10]
  return Math.max(1, Math.ceil(len / MACRO_CHUNK_SIZE))
}

export interface DecodedSlot {
  layer: number
  keyNo: number
  slot: Slot
  /** Why the packets were kept as raw (empty when decoded normally). */
  warnings: string[]
}

function interpret(packets: Uint8Array[]): Slot | string {
  const p = packets[0]
  const type = p[4]
  if (type === 0) {
    const n = p[5]
    if (n === 0) return EMPTY_SLOT
    if (n > MAX_TYPE0_CODES) return `code count ${n} does not fit in one packet`
    return { kind: 'codes', codes: [...p.subarray(6, 6 + n)] }
  }
  if (type === 1) {
    const n = p[7]
    if (n === 0 || n > MAX_EMULATE_CODES) return `emulate with ${n} codes`
    return { kind: 'emulate', value: (p[5] << 8) | p[6], codes: [...p.subarray(8, 8 + n)] }
  }
  if (type > 4) return `unknown slot type ${type}`

  const header = p.subarray(0, MACRO_HEADER_SIZE)
  if (packets.some(q => !bytesEqual(q.subarray(0, MACRO_HEADER_SIZE), header))) return 'macro packets have different headers'
  const len = (p[9] << 8) | p[10]
  if (len === 0) return 'macro with no events'
  if (packets.length !== expectedPacketCount(p)) return `macro needs ${expectedPacketCount(p)} packets, got ${packets.length}`
  const data: number[] = []
  for (const q of packets) data.push(...q.subarray(MACRO_HEADER_SIZE))
  data.length = len

  const hasDelays = p[6]
  const base = { kind: 'macro' as const, playMode: (type - 2) as 0 | 1 | 2, cycles: p[5], autoDelay: (p[7] << 8) | p[8] }
  if (hasDelays === 0) return { ...base, hasDelays: false, events: data, delays: [] }
  if (hasDelays !== 1) return `macro delay flag ${hasDelays}`
  if ((len - 1) % 4 !== 0) return `recorded macro length ${len} is not 4n−3`
  const events = [data[0]]
  const delays: number[] = []
  for (let i = 1; i < len; i += 4) {
    if (data[i] !== DELAY_MARKER) return `bad delay marker 0x${data[i].toString(16)} at data byte ${i}`
    delays.push((data[i + 1] << 8) | data[i + 2])
    events.push(data[i + 3])
  }
  return { ...base, hasDelays: true, events, delays }
}

/**
 * Decodes the packet(s) of one slot as the device sent them. Anything that is not understood, or that would not
 * re-encode to exactly the same bytes, is kept as `{kind: 'raw'}` so it can be written back unchanged — unless its
 * framing is broken (see rawFramingProblems), in which case validateSlot refuses to write it.
 */
export function decodeSlotPackets(packets: Uint8Array[]): DecodedSlot {
  if (packets.length === 0) throw new Error('decodeSlotPackets: no packets')
  const layer = packets[0][2]
  const keyNo = packets[0][3]
  const raw = (why: string): DecodedSlot => ({
    layer,
    keyNo,
    slot: { kind: 'raw', packets: packets.map(p => p.slice()) },
    warnings: [`L${layer} K${keyNo}: kept as raw (${why})`],
  })
  if (packets.some(p => p.length !== REPORT_SIZE)) return raw('packet is not 64 bytes')
  if (packets[0][1] !== CMD.SLOT) return raw('not a slot packet')
  if (layer !== 1 && layer !== 2) return raw('layer out of range')
  if (!isInt(keyNo, 1, KEY_COUNT)) return raw('key out of range')

  const slot = interpret(packets)
  if (typeof slot === 'string') return raw(slot)
  const problems = validateSlot(slot)
  if (problems.length) return raw(problems.join('; '))
  if (!packetsEqual(encodeSlot(layer, keyNo, slot), packets)) return raw('does not re-encode identically')
  return { layer, keyNo, slot, warnings: [] }
}

// --- read stream ------------------------------------------------------------------------------------------------

export interface ReadResult {
  table: SlotTable
  /** Which slots were actually received; a slot that was not stays empty in `table`. */
  seen: { base: boolean[]; fn: boolean[] }
  warnings: string[]
  /** Payloads consumed before the end marker (slot packets plus ignored ones). */
  packetCount: number
}

/** Rebuilds the 168-slot table from the device's answer to `00 F2`. Feed every payload until it returns 'done'. */
export class ReadAssembler {
  private readonly table = emptyTable()
  private readonly seen = { base: new Array<boolean>(KEY_COUNT).fill(false), fn: new Array<boolean>(KEY_COUNT).fill(false) }
  private readonly warnings: string[] = []
  private packetCount = 0
  private pending: Uint8Array[] | null = null
  private finished = false

  /** Number of distinct slots received so far. */
  get slotsReceived(): number {
    return this.seen.base.filter(Boolean).length + this.seen.fn.filter(Boolean).length
  }

  /** Payloads consumed so far, excluding the end marker. */
  get packetsAccepted(): number {
    return this.packetCount
  }

  get done(): boolean {
    return this.finished
  }

  accept(payload: Uint8Array): 'more' | 'done' {
    if (this.finished) return 'done'
    if (payload[0] === CMD.END) {
      this.flushPending('stream ended')
      this.finished = true
      return 'done'
    }
    this.packetCount++
    if (payload.length !== REPORT_SIZE) {
      this.warnings.push(`Ignored a ${payload.length}-byte report`)
      return 'more'
    }
    const p = payload.slice()

    if (this.pending) {
      const first = this.pending[0]
      // A continuation is any slot packet for the same slot; a changed header is flagged by decodeSlotPackets, and
      // keeping it here keeps all of the slot's packets together in the raw slot.
      if (p[1] === CMD.SLOT && p[2] === first[2] && p[3] === first[3]) {
        const packets = this.pending
        packets.push(p)
        if (packets.length === expectedPacketCount(first)) {
          this.pending = null
          this.store(packets)
        }
        return 'more'
      }
      this.flushPending('the next packet belongs to another slot')
    }

    if (p[1] !== CMD.SLOT) {
      this.warnings.push(`Ignored a packet with command 0x${p[1].toString(16).padStart(2, '0')}`)
      return 'more'
    }
    const layer = p[2]
    const keyNo = p[3]
    if ((layer !== 1 && layer !== 2) || !isInt(keyNo, 1, KEY_COUNT)) {
      this.warnings.push(`Ignored a slot packet for layer ${layer}, key ${keyNo}`)
      return 'more'
    }
    if (expectedPacketCount(p) > 1) this.pending = [p]
    else this.store([p])
    return 'more'
  }

  private flushPending(why: string): void {
    if (!this.pending) return
    const packets = this.pending
    this.pending = null
    const first = packets[0]
    this.warnings.push(
      `L${first[2]} K${first[3]}: macro incomplete (${packets.length}/${expectedPacketCount(first)} packets, ${why}); kept as raw, cannot be written back`,
    )
    this.put(first[2] as WireLayer, first[3], { kind: 'raw', packets })
  }

  private store(packets: Uint8Array[]): void {
    const d = decodeSlotPackets(packets)
    this.warnings.push(...d.warnings)
    this.put(d.layer as WireLayer, d.keyNo, d.slot)
  }

  private put(layer: WireLayer, keyNo: number, slot: Slot): void {
    const id = LAYER_OF_WIRE[layer]
    if (this.seen[id][keyNo - 1]) this.warnings.push(`L${layer} K${keyNo}: received twice, keeping the last one`)
    this.seen[id][keyNo - 1] = true
    this.table[id][keyNo - 1] = slot
  }

  /** The table so far. An unfinished multi-packet macro is reported and kept as raw. */
  result(): ReadResult {
    if (!this.finished) this.flushPending('stream not finished')
    return {
      table: { base: [...this.table.base], fn: [...this.table.fn] },
      seen: { base: [...this.seen.base], fn: [...this.seen.fn] },
      warnings: [...this.warnings],
      packetCount: this.packetCount,
    }
  }
}

// --- comparison -------------------------------------------------------------------------------------------------

const numsEqual = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * True when both slots put the same bytes on the wire. A raw slot is compared with the encoding of the other slot
 * at the raw packets' own layer/key.
 */
export function slotsEqual(a: Slot, b: Slot): boolean {
  if (a.kind === 'raw' || b.kind === 'raw') {
    const raw = (a.kind === 'raw' ? a : b) as Extract<Slot, { kind: 'raw' }>
    const other = raw === a ? b : a
    if (other.kind === 'raw') return packetsEqual(raw.packets, other.packets)
    const first = raw.packets[0]
    try {
      return !!first && packetsEqual(raw.packets, encodeSlot(first[2] as WireLayer, first[3], other))
    } catch {
      return false
    }
  }
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'empty':
      return true
    case 'codes':
      return numsEqual(a.codes, (b as typeof a).codes)
    case 'emulate': {
      const o = b as typeof a
      return a.value === o.value && numsEqual(a.codes, o.codes)
    }
    case 'macro': {
      const o = b as typeof a
      return (
        a.playMode === o.playMode &&
        a.cycles === o.cycles &&
        a.hasDelays === o.hasDelays &&
        a.autoDelay === o.autoDelay &&
        numsEqual(a.events, o.events) &&
        numsEqual(a.delays, o.delays)
      )
    }
  }
}

export interface SlotDiff {
  layer: LayerId
  keyNo: number
  a: Slot
  b: Slot
}

/** Slots that differ between two tables, base layer first, in key order. */
export function diffTables(a: SlotTable, b: SlotTable): SlotDiff[] {
  const out: SlotDiff[] = []
  for (const layer of ['base', 'fn'] as const)
    for (let i = 0; i < KEY_COUNT; i++) {
      const sa = a[layer][i] ?? EMPTY_SLOT
      const sb = b[layer][i] ?? EMPTY_SLOT
      if (!slotsEqual(sa, sb)) out.push({ layer, keyNo: i + 1, a: sa, b: sb })
    }
  return out
}
