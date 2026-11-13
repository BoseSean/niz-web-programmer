import { afterEach, describe, expect, it, vi } from 'vitest'
import { FACTORY, factoryTable } from '../device/layout'
import { SimulatedKeyboard, SimulatorTransport } from '../transport/simulator'
import { ReportQueue, type Transport } from '../transport/types'
import { CMD, diffTables, encodeSlot, readEnd, readRequest, writeBegin, writeEnd } from './codec'
import { DeviceTimeoutError, KeyboardSession, SlotValidationError, versionText } from './session'
import type { Slot, SlotTable } from './slots'

const noSleep = () => Promise.resolve()

function setup(opts: ConstructorParameters<typeof SimulatedKeyboard>[0] = {}) {
  const keyboard = new SimulatedKeyboard(opts)
  const log: Array<['out' | 'in', Uint8Array]> = []
  const transport = new SimulatorTransport(keyboard, (dir, p) => log.push([dir, p]))
  const session = new KeyboardSession(transport, { sleep: noSleep, firstTimeoutMs: 200, idleTimeoutMs: 200 })
  return { keyboard, transport, session, log }
}

const longMacro: Slot = {
  kind: 'macro',
  playMode: 0,
  cycles: 3,
  hasDelays: true,
  autoDelay: 0,
  events: Array.from({ length: 40 }, (_, i) => 43 + (i >> 1)),
  delays: Array.from({ length: 39 }, (_, i) => 10 + i * 300),
}

/** A table using every slot kind: codes, combo, emulate, auto/recorded/hold/toggle macros (one 3 packets long), raw. */
function richTable(): SlotTable {
  const t = factoryTable()
  // unknown wire type 9: must survive the round trip byte-exact
  t.base[4] = { kind: 'raw', packets: [Uint8Array.from([0, 0xf0, 1, 5, 9, 1, 2, 3, ...new Array(56).fill(0)])] }
  t.fn[52] = { kind: 'codes', codes: [55, 67, 43] }
  t.fn[53] = { kind: 'macro', playMode: 0, cycles: 2, hasDelays: false, autoDelay: 30, events: [43, 43, 60, 60], delays: [] }
  t.fn[54] = longMacro
  t.fn[55] = { kind: 'emulate', value: 300, codes: [56, 57] }
  t.fn[56] = { kind: 'macro', playMode: 1, cycles: 0, hasDelays: false, autoDelay: 30, events: [57, 57], delays: [] }
  t.fn[57] = { kind: 'macro', playMode: 2, cycles: 0, hasDelays: false, autoDelay: 1000, events: [58, 58], delays: [] }
  t.fn[66] = { kind: 'codes', codes: [130, 130] }
  t.fn[83] = { kind: 'empty' }
  return t
}

afterEach(() => {
  vi.useRealTimers()
})

describe('KeyboardSession + SimulatedKeyboard', () => {
  it('reads the factory bank with progress', async () => {
    const { session, log } = setup()
    const progress: number[] = []
    const res = await session.readAll(n => progress.push(n))
    expect(res.matchesFactory).toBe(true)
    expect(res.warnings).toEqual([])
    expect(res.packetCount).toBe(168)
    expect(diffTables(res.table, FACTORY)).toEqual([])
    expect(progress).toHaveLength(168)
    expect(progress.at(-1)).toBe(168)
    expect(log[0][0]).toBe('out')
    expect(log[0][1][1]).toBe(CMD.READ)
  })

  it('writes every slot kind and reads it back identically in Program mode', async () => {
    const { session, keyboard, log } = setup()
    const table = richTable()
    const sent: number[] = []
    const res = await session.writeAll(table, { onProgress: n => sent.push(n) })
    expect(res.diff).toEqual([])
    expect(res.verified).toBe(true)
    expect(res.likelyOfficeMode).toBe(false)
    expect(res.readBack?.matchesFactory).toBe(false)
    expect(res.readBack?.packetCount).toBe(170) // 168 slots + 2 continuation packets of the long macro
    expect(res.readBack?.table.fn[54]).toEqual(longMacro)
    expect(res.readBack?.table.base[4]).toEqual(table.base[4])
    expect(sent).toHaveLength(172)
    expect(diffTables(keyboard.getBank('program'), table)).toEqual([])

    const out = log.filter(([d]) => d === 'out').map(([, p]) => p)
    expect(out[0]).toEqual(writeBegin())
    expect(out[171]).toEqual(writeEnd())
    expect(out[172]).toEqual(readRequest())
  })

  it('writes land in the custom bank; an Office-mode read returns FACTORY and flags likelyOfficeMode', async () => {
    const { session, keyboard } = setup({ mode: 'office' })
    const table = richTable()
    const res = await session.writeAll(table)
    expect(res.verified).toBe(false)
    expect(res.likelyOfficeMode).toBe(true)
    expect(res.readBack?.matchesFactory).toBe(true)
    expect(res.diff.length).toBeGreaterThan(0)
    expect(diffTables(keyboard.getBank('office'), FACTORY)).toEqual([])

    expect(keyboard.toggleMode()).toBe('program')
    const back = await session.readAll()
    expect(diffTables(back.table, table)).toEqual([])
  })

  it('does not flag Office mode when writing the factory table', async () => {
    const { session } = setup({ mode: 'office' })
    const res = await session.writeAll(factoryTable())
    expect(res).toMatchObject({ verified: true, likelyOfficeMode: false, diff: [] })
  })

  it('can skip verification', async () => {
    const { session, log } = setup()
    const res = await session.writeAll(richTable(), { verify: false })
    expect(res).toEqual({ verified: false, diff: [], readBack: null, likelyOfficeMode: false })
    expect(log.filter(([d]) => d === 'out')).toHaveLength(172)
  })

  it('waits postWriteDelayMs after writing', async () => {
    const keyboard = new SimulatedKeyboard()
    const sleep = vi.fn(noSleep)
    const session = new KeyboardSession(new SimulatorTransport(keyboard), { sleep })
    await session.writeAll(factoryTable(), { verify: false })
    expect(sleep).toHaveBeenCalledWith(2000)
  })

  it('validation errors block writing', async () => {
    const { session, log, keyboard } = setup()
    const table = richTable()
    table.fn[10] = { kind: 'codes', codes: [] }
    table.base[0] = { kind: 'macro', playMode: 0, cycles: 0, hasDelays: false, autoDelay: 0, events: [4], delays: [] }
    const err = await session.writeAll(table).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SlotValidationError)
    expect((err as SlotValidationError).issues.map(i => `${i.layer}:${i.keyNo}`)).toEqual(['base:1', 'fn:11'])
    expect(log).toHaveLength(0)
    expect(diffTables(keyboard.getBank('program'), FACTORY)).toEqual([])
  })

  it('surfaces DeviceTimeoutError when the keyboard does not answer', async () => {
    const { session, keyboard } = setup()
    keyboard.muted = true
    await expect(session.readAll()).rejects.toBeInstanceOf(DeviceTimeoutError)
    await expect(session.readAll()).rejects.toThrow(/did not answer/)
    keyboard.muted = false
    expect((await session.readAll()).matchesFactory).toBe(true) // the queue keeps working after a failure
  })

  it('surfaces DeviceTimeoutError when a read stops halfway', async () => {
    const queue = new ReportQueue()
    const transport: Transport = {
      info: { name: 'half', vendorId: 0, productId: 0, kind: 'simulator' },
      async send() {
        for (let k = 1; k <= 10; k++) queue.push(encodeSlot(1, k, { kind: 'empty' })[0])
      },
      receive: ms => queue.next(ms),
      flush: () => queue.clear(),
      close: async () => {},
    }
    const session = new KeyboardSession(transport, { firstTimeoutMs: 50, idleTimeoutMs: 20 })
    await expect(session.readAll()).rejects.toThrow(/stopped answering after 10 of 168/)
  })

  it('reports incomplete reads as warnings via seen (end marker arrives early)', async () => {
    const queue = new ReportQueue()
    const transport: Transport = {
      info: { name: 'short', vendorId: 0, productId: 0, kind: 'simulator' },
      async send() {
        queue.push(encodeSlot(1, 1, { kind: 'codes', codes: [1] })[0])
        queue.push(readEnd())
      },
      receive: ms => queue.next(ms),
      flush: () => queue.clear(),
      close: async () => {},
    }
    const res = await new KeyboardSession(transport).readAll()
    expect(res.seen.base.filter(Boolean)).toHaveLength(1)
    expect(res.matchesFactory).toBe(false)
  })

  it('serializes concurrent operations', async () => {
    const { session, log } = setup()
    const table = richTable()
    const [before, written, after] = await Promise.all([session.readAll(), session.writeAll(table), session.readAll()])
    expect(before.matchesFactory).toBe(true)
    expect(written.verified).toBe(true)
    expect(diffTables(after.table, table)).toEqual([])
    const cmds = log.filter(([d, p]) => d === 'out' && p[1] !== CMD.SLOT).map(([, p]) => p[1])
    expect(cmds).toEqual([CMD.READ, CMD.WRITE_BEGIN, CMD.END, CMD.READ, CMD.READ])
  })

  it('reads the version and probes lighting', async () => {
    const { session } = setup({ version: 'V1.5.1' })
    const v = await session.readVersion()
    expect(v?.text).toBe('V1.5.1')
    expect(v?.raw[1]).toBe(CMD.VERSION)
    expect(await session.probeLighting()).toBe(false)
  })

  it('decodes the F9 text like KB84: the 62 bytes after p[0..1], ANSI code page, up to the first NUL', () => {
    const raw = new Uint8Array(64)
    raw.set([0xaa, 0xbb, 0x56, 0x31, 0x2e, 0x35, 0x80, 0x00, 0x41]) // p[0..1] are not checked
    expect(versionText(raw)).toBe('V1.5€') // 0x80 is € in Windows-1252, not U+0080
    const full = new Uint8Array(64).fill(0x41)
    expect(versionText(full)).toBe('A'.repeat(62))
  })

  it('returns null when the version request times out', async () => {
    vi.useFakeTimers()
    const { session, keyboard } = setup()
    keyboard.muted = true
    const p = session.readVersion()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toBeNull()
  })

  it('reports lighting when E0 chunks arrive', async () => {
    const queue = new ReportQueue()
    const chunk = new Uint8Array(64)
    chunk[1] = CMD.LIGHT_CHUNK
    const transport: Transport = {
      info: { name: 'rgb', vendorId: 0, productId: 0, kind: 'simulator' },
      async send() {
        queue.push(chunk)
        queue.push(new Uint8Array(64).fill(CMD.LIGHT_END))
      },
      receive: ms => queue.next(ms),
      flush: () => queue.clear(),
      close: async () => {},
    }
    expect(await new KeyboardSession(transport).probeLighting()).toBe(true)
  })
})

describe('SimulatedKeyboard', () => {
  it('commits a write only on the end packet', async () => {
    const keyboard = new SimulatedKeyboard()
    keyboard.handle(writeBegin())
    keyboard.handle(encodeSlot(1, 1, { kind: 'codes', codes: [41] })[0])
    expect(diffTables(keyboard.getBank(), FACTORY)).toEqual([])
    keyboard.handle(writeEnd())
    expect(keyboard.getBank().base[0]).toEqual({ kind: 'codes', codes: [41] })
    // slot packets outside a write and unknown commands are ignored
    keyboard.handle(encodeSlot(1, 2, { kind: 'codes', codes: [41] })[0])
    keyboard.handle(Uint8Array.from([0, 0x3a, 1, 2, 3]))
    expect(keyboard.getBank().base[1]).toEqual(FACTORY.base[1])
  })

  it('keeps the program bank separate from the input table and from FACTORY', () => {
    const program = factoryTable()
    const keyboard = new SimulatedKeyboard({ program, mode: 'office' })
    program.base[0] = { kind: 'empty' }
    expect(keyboard.getBank('program').base[0]).toEqual(FACTORY.base[0])
    expect(keyboard.getMode()).toBe('office')
    keyboard.setMode('program')
    expect(keyboard.getMode()).toBe('program')
  })

  it('does not alias slot objects between the caller and the simulated memory', () => {
    const program = factoryTable()
    const keyboard = new SimulatedKeyboard({ program })
    const esc = program.base[0]
    if (esc.kind !== 'codes') throw new Error('factory Esc is not a code slot')
    esc.codes.push(4) // edit the caller's table in place: the device must not see it
    const bank = keyboard.getBank()
    const got = bank.base[0]
    if (got.kind !== 'codes') throw new Error('unexpected slot kind')
    got.codes.push(5) // edit a returned copy: the device must not see it either
    expect(keyboard.getBank().base[0]).toEqual(FACTORY.base[0])
  })

  it('delivers responses asynchronously with latency', async () => {
    vi.useFakeTimers()
    const transport = new SimulatorTransport(new SimulatedKeyboard({ latencyMs: 8 }))
    expect(transport.info).toMatchObject({ kind: 'simulator', name: 'Simulated 84EC-S', vendorId: 0x0483, productId: 0x5025 })
    await transport.send(readRequest())
    const first = transport.receive(5)
    const rejected = expect(first).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(5)
    await rejected
    const next = transport.receive(100)
    await vi.advanceTimersByTimeAsync(8)
    expect((await next)[1]).toBe(CMD.SLOT)
    await transport.close()
  })
})
