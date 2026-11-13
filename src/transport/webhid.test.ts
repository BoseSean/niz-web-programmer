/**
 * WebHID interface selection and input filtering (PROTOCOL.md §2, §3). KB84 accepts only the vid_0483 / pid_5025 /
 * mi_01 interface and always reads whole 65-byte reports (KB84HWI 0x10002420 and 0x100033e0; REA ev_15f688a3…,
 * ev_170f9295…), so the web side must pick only the 0x8C collection with 64-byte reports and drop odd-sized input.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyOpenError, configDevices, isChooserDismissal, isConfigInterface, pickConfigDevice, WebHidTransport } from './webhid'

const report = (bytes: number): HIDReportInfo => ({ reportId: 0, items: [{ reportSize: 8, reportCount: bytes }] }) as HIDReportInfo

interface FakeOptions {
  usagePage: number
  inBytes?: number
  outBytes?: number
  productId?: number
}

function fakeDevice({ usagePage, inBytes = 64, outBytes = 64, productId = 0x5025 }: FakeOptions) {
  const listeners: Array<(e: HIDInputReportEvent) => void> = []
  const device = {
    vendorId: 0x0483,
    productId,
    productName: '84EC-S',
    opened: true,
    collections: [{ usagePage, usage: 1, inputReports: [report(inBytes)], outputReports: [report(outBytes)] }],
    addEventListener: (_: string, l: (e: HIDInputReportEvent) => void) => listeners.push(l),
    removeEventListener: () => undefined,
    sendReport: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }
  const emit = (bytes: Uint8Array, reportId = 0) =>
    listeners.forEach((l) => l({ reportId, data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) } as HIDInputReportEvent))
  return { device: device as unknown as HIDDevice, emit }
}

describe('configuration interface selection', () => {
  it('needs usage page 0x8C and 64-byte input and output reports on the same collection', () => {
    expect(isConfigInterface(fakeDevice({ usagePage: 0x8c }).device)).toBe(true)
    // the 0x8C branch used to skip the report-size check
    expect(isConfigInterface(fakeDevice({ usagePage: 0x8c, inBytes: 8 }).device)).toBe(false)
    expect(isConfigInterface(fakeDevice({ usagePage: 0x8c, outBytes: 32 }).device)).toBe(false)
    // and the fallback accepted any collection with 64-byte reports
    expect(isConfigInterface(fakeDevice({ usagePage: 0xff00 }).device)).toBe(false)
  })

  it('picks only the 0483:5025 config interface and has no fallback', () => {
    const keyboard = fakeDevice({ usagePage: 0x01, inBytes: 8, outBytes: 1 }).device
    const vendor = fakeDevice({ usagePage: 0xff00 }).device
    const config = fakeDevice({ usagePage: 0x8c }).device
    expect(pickConfigDevice([keyboard, vendor, config])).toBe(config)
    expect(pickConfigDevice([keyboard, vendor])).toBeUndefined()
    expect(pickConfigDevice([fakeDevice({ usagePage: 0x8c, productId: 0x5024 }).device])).toBeUndefined()
  })
})

describe('WebHidTransport input', () => {
  afterEach(() => vi.restoreAllMocks())

  it('passes 64-byte reports through and drops reports of any other size', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { device, emit } = fakeDevice({ usagePage: 0x8c })
    const seen: Uint8Array[] = []
    const t = await WebHidTransport.open(device, '84EC-S', (dir, p) => dir === 'in' && seen.push(p))
    const short = new Uint8Array(8).fill(0xf6) // padded, this would have looked like a read end marker
    emit(short)
    emit(new Uint8Array(65))
    emit(new Uint8Array(64).fill(1), 2) // other report id
    const good = new Uint8Array(64)
    good.set([0x00, 0xf0, 0x01, 0x01, 0x00, 0x01, 0x01])
    emit(good)
    expect(await t.receive(10)).toEqual(good)
    expect(seen).toEqual([good])
    expect(warn).toHaveBeenCalledTimes(2)
    await expect(t.receive(5)).rejects.toThrow(/Timed out/)
  })
})

describe('connection helpers', () => {
  it('lists every distinct configuration interface (auto-connect needs exactly one)', () => {
    const a = fakeDevice({ usagePage: 0x8c }).device
    const b = fakeDevice({ usagePage: 0x8c }).device
    const kbd = fakeDevice({ usagePage: 0x01, inBytes: 8, outBytes: 1 }).device
    expect(configDevices([kbd, a, a])).toEqual([a])
    expect(configDevices([a, kbd, b])).toEqual([a, b])
    expect(configDevices([kbd])).toEqual([])
  })

  it('classifies open() and chooser errors', () => {
    const dom = (name: string) => Object.assign(new Error('Failed to open the device.'), { name })
    expect(classifyOpenError(dom('InvalidStateError'))).toBe('busy')
    expect(classifyOpenError(dom('NetworkError'))).toBe('busy')
    expect(classifyOpenError(new Error('x'))).toBe('busy')
    expect(classifyOpenError(dom('NotAllowedError'))).toBe('denied')
    expect(classifyOpenError(dom('SecurityError'))).toBe('denied')
    expect(isChooserDismissal(dom('NotFoundError'))).toBe(true)
    expect(isChooserDismissal(dom('NotAllowedError'))).toBe(true)
    expect(isChooserDismissal(dom('SecurityError'))).toBe(false)
    expect(isChooserDismissal(null)).toBe(false)
  })
})
