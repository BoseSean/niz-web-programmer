/**
 * High-level keyboard operations over a Transport: full read, full write (+ verification read), version and the
 * lighting probe. One operation runs at a time; concurrent calls are queued.
 */
import { FACTORY } from '../device/layout'
import { TimeoutError, type Transport } from '../transport/types'
import {
  CMD,
  diffTables,
  encodeWriteSequence,
  lightReadRequest,
  readRequest,
  ReadAssembler,
  SLOT_COUNT,
  SlotValidationError,
  validateTable,
  versionRequest,
  type ReadResult,
  type SlotDiff,
} from './codec'
import type { SlotTable } from './slots'

export { SlotValidationError } from './codec'

/** The keyboard did not answer (or stopped answering) in time. */
export class DeviceTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeviceTimeoutError'
  }
}

export interface SessionOptions {
  /** Wait for the first answer to a request. */
  firstTimeoutMs?: number
  /** Max silence between packets of one answer. */
  idleTimeoutMs?: number
  /** Pause after a key write before anything else (KB84 sleeps 2 s). */
  postWriteDelayMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface SessionReadResult extends ReadResult {
  /** Every slot was received and the table equals the factory bank (what Office mode returns). */
  matchesFactory: boolean
}

export interface WriteOptions {
  /** Called after each report is sent: (sent, total). */
  onProgress?: (sent: number, total: number) => void
  /** Read back and compare after writing (default true). */
  verify?: boolean
}

export interface WriteResult {
  /** Read-back received every slot and equals the written table. Always false when verify is off. */
  verified: boolean
  /** Written (a) vs read back (b); empty when verified or not verified at all. */
  diff: SlotDiff[]
  readBack: SessionReadResult | null
  /** The read-back is the factory bank while the written table is not: the keyboard is probably in Office mode. */
  likelyOfficeMode: boolean
}

export interface VersionInfo {
  text: string
  raw: Uint8Array
}

/** Hard stop for a device that streams without ever sending the end marker. */
const MAX_READ_PACKETS = 4096

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export class KeyboardSession {
  readonly transport: Transport
  private readonly firstTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly postWriteDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private queue: Promise<unknown> = Promise.resolve()

  constructor(transport: Transport, opts: SessionOptions = {}) {
    this.transport = transport
    this.firstTimeoutMs = opts.firstTimeoutMs ?? 1500
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 1000
    this.postWriteDelayMs = opts.postWriteDelayMs ?? 2000
    this.sleep = opts.sleep ?? defaultSleep
  }

  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Receives one payload, turning a transport timeout into DeviceTimeoutError with `what` as context. */
  private async receive(timeoutMs: number, what: string): Promise<Uint8Array> {
    try {
      return await this.transport.receive(timeoutMs)
    } catch (e) {
      if (e instanceof TimeoutError) throw new DeviceTimeoutError(`${what} (no answer within ${timeoutMs} ms)`)
      throw e
    }
  }

  readAll(onProgress?: (received: number, total: number) => void): Promise<SessionReadResult> {
    return this.exclusive(() => this.doRead(onProgress))
  }

  private async doRead(onProgress?: (received: number, total: number) => void): Promise<SessionReadResult> {
    this.transport.flush()
    await this.transport.send(readRequest())
    const asm = new ReadAssembler()
    let first = true
    while (!asm.done) {
      const p = await this.receive(
        first ? this.firstTimeoutMs : this.idleTimeoutMs,
        first
          ? 'The keyboard did not answer the read request. Replug it and try again'
          : `The keyboard stopped answering after ${asm.slotsReceived} of ${SLOT_COUNT} keys. Replug it and try again`,
      )
      first = false
      const before = asm.slotsReceived
      asm.accept(p)
      if (asm.slotsReceived !== before) onProgress?.(asm.slotsReceived, SLOT_COUNT)
      if (!asm.done && asm.packetsAccepted > MAX_READ_PACKETS)
        throw new Error(`The keyboard sent more than ${MAX_READ_PACKETS} packets without ending the read`)
    }
    const res = asm.result()
    const complete = res.seen.base.every(Boolean) && res.seen.fn.every(Boolean)
    return { ...res, matchesFactory: complete && diffTables(res.table, FACTORY).length === 0 }
  }

  /**
   * Writes all 168 slots. Writes always land in the custom (Program-mode) bank; a read only returns that bank while
   * the keyboard is in Program mode (M light on), so `likelyOfficeMode` flags the usual cause of a failed verify.
   */
  writeAll(table: SlotTable, opts: WriteOptions = {}): Promise<WriteResult> {
    return this.exclusive(async () => {
      const issues = validateTable(table)
      if (issues.length) throw new SlotValidationError(issues)
      const sequence = encodeWriteSequence(table)
      this.transport.flush()
      for (let i = 0; i < sequence.length; i++) {
        await this.transport.send(sequence[i])
        opts.onProgress?.(i + 1, sequence.length)
      }
      await this.sleep(this.postWriteDelayMs)
      if (opts.verify === false) return { verified: false, diff: [], readBack: null, likelyOfficeMode: false }

      const readBack = await this.doRead()
      const diff = diffTables(table, readBack.table)
      const complete = readBack.seen.base.every(Boolean) && readBack.seen.fn.every(Boolean)
      const verified = complete && diff.length === 0
      return {
        verified,
        diff,
        readBack,
        likelyOfficeMode: !verified && readBack.matchesFactory && diffTables(table, FACTORY).length > 0,
      }
    })
  }

  /**
   * Firmware version (F9). Null when the keyboard does not answer within 1 s (KB84 itself would block forever: its
   * read ignores the timeout). The reply format is unverified; the live capture contains no F9 exchange.
   */
  readVersion(): Promise<VersionInfo | null> {
    return this.exclusive(async () => {
      this.transport.flush()
      await this.transport.send(versionRequest())
      let raw: Uint8Array
      try {
        raw = await this.transport.receive(1000)
      } catch (e) {
        if (e instanceof TimeoutError) return null
        throw e
      }
      return { text: versionText(raw), raw }
    })
  }

  /** Sends the light read (E2). True only if E0 data chunks arrive; the 84EC-S answers E6 at once (no lighting). */
  probeLighting(): Promise<boolean> {
    return this.exclusive(async () => {
      this.transport.flush()
      await this.transport.send(lightReadRequest())
      let sawChunk = false
      for (let i = 0, timeout = this.firstTimeoutMs; i < 64; i++, timeout = this.idleTimeoutMs) {
        let p: Uint8Array
        try {
          p = await this.transport.receive(timeout)
        } catch (e) {
          if (e instanceof TimeoutError) break
          throw e
        }
        if (p[0] === CMD.LIGHT_END || p[1] === CMD.LIGHT_END) break
        if (p[1] === CMD.LIGHT_CHUNK) sawChunk = true
      }
      return sawChunk
    })
  }
}

/**
 * Text of an F9 reply as KB84 shows it: `MultiByteToWideChar(CP_ACP, 0, p + 2, 62, out, 62)` (KB84HWI 0x10002360,
 * REA ev_a6faf0dd…). Exactly the 62 bytes p[2..63] are converted with the system ANSI code page; the result ends at
 * the first NUL only because the reply contains one. Windows-1252 (the CP_ACP of Western Windows) stands in for it;
 * p[0] and p[1] are not checked, as in KB84.
 */
export function versionText(raw: Uint8Array): string {
  const body = raw.subarray(2, 64)
  const end = body.indexOf(0)
  return Array.from(end < 0 ? body : body.subarray(0, end), (b) => String.fromCharCode(CP1252_80_9F[b - 0x80] ?? b)).join('')
}

/**
 * Windows-1252 code points for bytes 0x80–0x9F (all other bytes equal their code point). Spelled out because some
 * TextDecoder implementations (Node) decode the "windows-1252" label as ISO-8859-1.
 */
const CP1252_80_9F = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
]
