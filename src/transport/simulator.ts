/**
 * In-memory 84EC-S that speaks the real protocol, for development without hardware and for tests.
 * Mirrors the live-capture findings: Office mode (M light off) reads return the factory bank, Program mode
 * (M light on) reads return the custom bank, and writes always go to the custom bank.
 */
import { FACTORY } from '../device/layout'
import { USB_PRODUCT_ID, USB_VENDOR_ID } from '../device/types'
import { CMD, encodeSlot, readEnd, ReadAssembler } from '../protocol/codec'
import type { Slot, SlotTable } from '../protocol/slots'
import { REPORT_SIZE, ReportQueue, toReport, type PacketListener, type Transport, type TransportInfo } from './types'

export type KeyboardMode = 'program' | 'office'

export interface SimulatedKeyboardOptions {
  mode?: KeyboardMode
  /** Initial custom bank (default: a copy of the factory bank). */
  program?: SlotTable
  /** Text returned for the F9 version request. */
  version?: string
  /** Delay before each response report is delivered by SimulatorTransport. */
  latencyMs?: number
}

function copySlot(s: Slot): Slot {
  switch (s.kind) {
    case 'empty':
      return s
    case 'codes':
    case 'emulate':
      return { ...s, codes: [...s.codes] }
    case 'macro':
      return { ...s, events: [...s.events], delays: [...s.delays] }
    case 'raw':
      return { kind: 'raw', packets: s.packets.map(p => p.slice()) }
  }
}

/** Deep copy, so neither the caller's table nor getBank() results alias the simulated device memory. */
const copyTable = (t: SlotTable): SlotTable => ({ base: t.base.map(copySlot), fn: t.fn.map(copySlot) })

export class SimulatedKeyboard {
  readonly version: string
  readonly latencyMs: number
  /** Receives every response report. Set by SimulatorTransport. */
  onResponse: ((payload: Uint8Array) => void) | null = null
  /** When true the keyboard ignores every request (simulates a hung / unplugged device). */
  muted = false
  private mode: KeyboardMode
  private program: SlotTable
  /** Slot packets received since `00 F1`, or null when no write is in progress. */
  private writing: Uint8Array[] | null = null

  constructor(opts: SimulatedKeyboardOptions = {}) {
    this.mode = opts.mode ?? 'program'
    this.program = copyTable(opts.program ?? FACTORY)
    this.version = opts.version ?? 'SIM-84EC-S 1.0'
    this.latencyMs = opts.latencyMs ?? 0
  }

  getMode(): KeyboardMode {
    return this.mode
  }

  setMode(mode: KeyboardMode): void {
    this.mode = mode
  }

  /** Like holding Fn+F12 for ~2 s. */
  toggleMode(): KeyboardMode {
    this.mode = this.mode === 'program' ? 'office' : 'program'
    return this.mode
  }

  /** A copy of a bank: 'office' = factory (read-only), 'program' = custom bank. */
  getBank(mode: KeyboardMode = this.mode): SlotTable {
    return copyTable(mode === 'office' ? FACTORY : this.program)
  }

  private respond(payload: Uint8Array): void {
    this.onResponse?.(payload)
  }

  /** Processes one host → device report. */
  handle(payload: Uint8Array): void {
    if (this.muted) return
    const p = toReport(payload)
    if (p[0] !== 0) return
    switch (p[1]) {
      case CMD.WRITE_BEGIN:
        this.writing = []
        break
      case CMD.SLOT:
        this.writing?.push(p.slice())
        break
      case CMD.END:
        if (this.writing) this.commit(this.writing)
        this.writing = null
        break
      case CMD.READ: {
        const bank = this.mode === 'office' ? FACTORY : this.program
        for (const [layer, slots] of [[1, bank.base], [2, bank.fn]] as const)
          slots.forEach((slot, i) => encodeSlot(layer, i + 1, slot).forEach(r => this.respond(r)))
        this.respond(readEnd())
        break
      }
      case CMD.VERSION: {
        const r = new Uint8Array(REPORT_SIZE)
        r[1] = CMD.VERSION
        const text = [...this.version].map(c => c.charCodeAt(0) & 0x7f).slice(0, REPORT_SIZE - 3)
        r.set(text, 2)
        this.respond(r)
        break
      }
      case CMD.LIGHT_READ:
        this.respond(new Uint8Array(REPORT_SIZE).fill(CMD.LIGHT_END))
        break
      default:
        break // unknown commands (light write, firmware records, …) are ignored
    }
  }

  /** Applies a finished write atomically. Slots the host did not send keep their previous value. */
  private commit(packets: Uint8Array[]): void {
    const asm = new ReadAssembler()
    packets.forEach(p => asm.accept(p))
    asm.accept(readEnd())
    const { table, seen } = asm.result()
    const next = copyTable(this.program)
    for (const layer of ['base', 'fn'] as const)
      seen[layer].forEach((got, i) => {
        if (got) next[layer][i] = table[layer][i]
      })
    this.program = next
  }
}

export class SimulatorTransport implements Transport {
  readonly info: TransportInfo = {
    name: 'Simulated 84EC-S',
    vendorId: USB_VENDOR_ID,
    productId: USB_PRODUCT_ID,
    kind: 'simulator',
  }
  readonly keyboard: SimulatedKeyboard
  private readonly queue = new ReportQueue()
  private readonly listener: PacketListener | undefined
  private closed = false
  /** Responses are delivered one after another, each `latencyMs` after the previous one. */
  private delivery: Promise<void> = Promise.resolve()

  constructor(keyboard: SimulatedKeyboard = new SimulatedKeyboard(), listener?: PacketListener) {
    this.keyboard = keyboard
    this.listener = listener
    keyboard.onResponse = payload => this.deliver(payload)
  }

  private deliver(payload: Uint8Array): void {
    const latency = this.keyboard.latencyMs
    this.delivery = this.delivery
      .then(() => (latency > 0 ? new Promise<void>(resolve => setTimeout(resolve, latency)) : undefined))
      .then(() => {
        if (this.closed) return
        const report = toReport(payload).slice()
        this.listener?.('in', report)
        this.queue.push(report)
      })
  }

  async send(payload: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('Simulator transport is closed')
    const report = toReport(payload).slice()
    this.listener?.('out', report)
    this.keyboard.handle(report)
  }

  receive(timeoutMs: number): Promise<Uint8Array> {
    return this.queue.next(timeoutMs)
  }

  flush(): void {
    this.queue.clear()
  }

  async close(): Promise<void> {
    this.closed = true
    this.keyboard.onResponse = null
  }
}
