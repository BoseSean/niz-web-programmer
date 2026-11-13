// @vitest-environment jsdom
/**
 * Connection experience of useDevice with a fake navigator.hid: auto-connect on load, the 断开 pause, reconnect on a
 * 'connect' event, the busy (open() rejected) failure and 重试, quiet chooser dismissal, and storage that throws.
 * Also `granted`, and how errors are worded (failures of the link to the keyboard vs the page's own).
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FACTORY } from '../../device/layout'
import { SimulatedKeyboard } from '../../transport/simulator'
import { PacketLog } from './packetLog'
import {
  AUTO_CONNECT_KEY,
  DeviceError,
  joinSentences,
  loadAutoConnect,
  saveAutoConnect,
  useDevice,
  type DeviceOptions,
  type StorageLike,
} from './useDevice'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const report = (bytes: number) => ({ reportId: 0, items: [{ reportSize: 8, reportCount: bytes }] })

type FakeDevice = HIDDevice & {
  /** open() rejects while this is > 0 (and counts down). */
  failOpens: number
  openCalls: number
}

function fakeDevice(usagePage = 0x8c, productName = '84EC-S'): FakeDevice {
  const d = {
    vendorId: 0x0483,
    productId: 0x5025,
    productName,
    opened: false,
    failOpens: 0,
    openCalls: 0,
    collections: [{ usagePage, usage: 1, inputReports: [report(64)], outputReports: [report(64)] }],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    sendReport: () => Promise.resolve(),
    async open() {
      d.openCalls++
      if (d.failOpens > 0) {
        d.failOpens--
        throw new DOMException('Failed to open the device.', 'InvalidStateError')
      }
      d.opened = true
    },
    async close() {
      d.opened = false
    },
  }
  return d as unknown as FakeDevice
}

class FakeHid extends EventTarget {
  /** Devices this origin is allowed to use (what getDevices() returns). */
  authorised: HIDDevice[] = []
  /** What the chooser returns; an Error is thrown instead. */
  choose: HIDDevice[] | Error | DOMException = []
  readonly requestDevice = vi.fn(async (_opts: HIDDeviceRequestOptions) => {
    if (!Array.isArray(this.choose)) throw this.choose
    for (const d of this.choose) if (!this.authorised.includes(d)) this.authorised.push(d)
    return this.choose
  })
  readonly getDevices = vi.fn(async () => [...this.authorised])

  plug(device: HIDDevice) {
    if (!this.authorised.includes(device)) this.authorised.push(device)
    this.dispatchEvent(Object.assign(new Event('connect'), { device }))
  }

  unplug(device: HIDDevice) {
    this.authorised = this.authorised.filter((d) => d !== device)
    ;(device as unknown as { opened: boolean }).opened = false
    this.dispatchEvent(Object.assign(new Event('disconnect'), { device }))
  }
}

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

function setup(hid: FakeHid | null, extra: DeviceOptions = {}, strict = false) {
  const log = new PacketLog()
  const onAutoConnected = vi.fn()
  const onUnplugged = vi.fn()
  const storage = extra.storage !== undefined ? extra.storage : memoryStorage()
  const wrapper = strict ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> : undefined
  const hook = renderHook(
    () =>
      useDevice(log, {
        hid: hid as unknown as HID | null,
        storage,
        reconnectDelayMs: 0,
        onAutoConnected,
        onUnplugged,
        ...extra,
      }),
    { wrapper },
  )
  return { ...hook, onAutoConnected, onUnplugged, storage }
}

/** Lets pending promise chains (getDevices → open → setState) settle. */
const settle = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 10; i++) await Promise.resolve()
})

describe('auto-connect on page load', () => {
  it('opens the single authorised configuration interface without the chooser', async () => {
    const hid = new FakeHid()
    // Windows names the configuration interface "Program" (seen on a real 84EC-S): the model is shown instead.
    const kb = fakeDevice(0x8c, 'Program')
    hid.authorised = [fakeDevice(0x01), kb] // the keyboard interface is ignored
    const { result, onAutoConnected } = setup(hid)
    await waitFor(() => expect(result.current.ui.connected).toBe(true))
    expect(result.current.ui).toMatchObject({ kind: 'webhid', name: '84EC-S', auto: true, failure: null, busy: null })
    expect(hid.requestDevice).not.toHaveBeenCalled()
    expect(onAutoConnected).toHaveBeenCalledWith('84EC-S')
    expect(kb.opened).toBe(true)
  })

  it('stays idle with zero or several authorised keyboards, or when switched off', async () => {
    const none = setup(new FakeHid())
    await settle()
    expect(none.result.current.ui.connected).toBe(false)
    none.unmount()

    const two = new FakeHid()
    const a = fakeDevice()
    const b = fakeDevice()
    two.authorised = [a, b]
    const several = setup(two)
    await settle()
    expect(several.result.current.ui.connected).toBe(false)
    expect(a.openCalls + b.openCalls).toBe(0)
    several.unmount()

    const off = new FakeHid()
    const kb = fakeDevice()
    off.authorised = [kb]
    const disabled = setup(off, { storage: memoryStorage({ [AUTO_CONNECT_KEY]: '0' }) })
    await settle()
    expect(disabled.result.current.ui).toMatchObject({ connected: false, autoConnect: false })
    expect(kb.openCalls).toBe(0)
  })

  it('opens the keyboard only once under StrictMode', async () => {
    const hid = new FakeHid()
    const kb = fakeDevice()
    hid.authorised = [kb]
    const { result } = setup(hid, {}, true)
    await waitFor(() => expect(result.current.ui.connected).toBe(true))
    await settle()
    expect(kb.openCalls).toBe(1)
    expect(result.current.ui.connected).toBe(true)
  })

  it('turning the switch on connects right away and is persisted', async () => {
    const hid = new FakeHid()
    hid.authorised = [fakeDevice()]
    const storage = memoryStorage({ [AUTO_CONNECT_KEY]: '0' })
    const { result } = setup(hid, { storage })
    await settle()
    expect(result.current.ui.connected).toBe(false)
    act(() => result.current.setAutoConnect(true))
    await waitFor(() => expect(result.current.ui.connected).toBe(true))
    expect(storage.data.get(AUTO_CONNECT_KEY)).toBe('1')
    act(() => result.current.setAutoConnect(false))
    expect(storage.data.get(AUTO_CONNECT_KEY)).toBe('0')
    expect(result.current.ui).toMatchObject({ autoConnect: false, connected: true }) // switching off keeps the connection
  })
})

describe('plug and unplug', () => {
  it('handles disconnect as before and reconnects automatically when the keyboard comes back', async () => {
    const hid = new FakeHid()
    const kb = fakeDevice()
    hid.authorised = [kb]
    const { result, onUnplugged, onAutoConnected } = setup(hid)
    await waitFor(() => expect(result.current.ui.connected).toBe(true))

    act(() => hid.unplug(kb))
    await waitFor(() => expect(result.current.ui.connected).toBe(false))
    expect(onUnplugged).toHaveBeenCalledTimes(1)

    act(() => hid.plug(kb))
    await waitFor(() => expect(result.current.ui.connected).toBe(true))
    expect(result.current.ui.auto).toBe(true)
    expect(onAutoConnected).toHaveBeenCalledTimes(2)
  })

  it('ignores other interfaces of the keyboard and other devices', async () => {
    const hid = new FakeHid()
    const { result } = setup(hid)
    await settle()
    const other = fakeDevice(0x01)
    act(() => hid.plug(other))
    await settle()
    expect(result.current.ui.connected).toBe(false)
    expect(other.openCalls).toBe(0)
  })

  it('retries open() a few times after a plug-in, while the keyboard is still starting up', async () => {
    const hid = new FakeHid()
    const kb = fakeDevice()
    kb.failOpens = 2
    const { result } = setup(hid, { reconnectAttempts: 3 })
    await settle()
    act(() => hid.plug(kb))
    await waitFor(() => expect(result.current.ui.connected).toBe(true))
    expect(kb.openCalls).toBe(3)
  })
})

describe('断开 pauses auto-connect for the page session', () => {
  it('does not reconnect after 断开 until 连接键盘 is pressed again', async () => {
    const hid = new FakeHid()
    const kb = fakeDevice()
    hid.authorised = [kb]
    const { result } = setup(hid)
    await waitFor(() => expect(result.current.ui.connected).toBe(true))

    await act(() => result.current.disconnect())
    expect(result.current.ui).toMatchObject({ connected: false, autoPaused: true })
    expect(kb.opened).toBe(false)

    // Re-plugging the keyboard does not connect it.
    act(() => hid.unplug(kb))
    act(() => hid.plug(kb))
    await settle()
    expect(result.current.ui.connected).toBe(false)
    // Neither does switching auto-connect off and on.
    act(() => result.current.setAutoConnect(false))
    act(() => result.current.setAutoConnect(true))
    await settle()
    expect(result.current.ui.connected).toBe(false)

    // 连接键盘 (chooser) lifts the pause …
    hid.choose = [kb]
    let ok = false
    await act(async () => {
      ok = await result.current.connectHid()
    })
    expect(ok).toBe(true)
    expect(result.current.ui).toMatchObject({ connected: true, auto: false, autoPaused: false })
    expect(hid.requestDevice).toHaveBeenCalledTimes(1)

    // … so the next plug-in reconnects again.
    act(() => hid.unplug(kb))
    await waitFor(() => expect(result.current.ui.connected).toBe(false))
    act(() => hid.plug(kb))
    await waitFor(() => expect(result.current.ui.connected).toBe(true))
  })

  it('a cancelled chooser also lifts the pause but connects nothing', async () => {
    const hid = new FakeHid()
    const { result } = setup(hid)
    await act(() => result.current.connectSimulator())
    await act(() => result.current.disconnect())
    expect(result.current.ui.autoPaused).toBe(true)
    hid.choose = []
    await act(async () => void (await result.current.connectHid()))
    expect(result.current.ui).toMatchObject({ connected: false, autoPaused: false, failure: null, busy: null })
  })
})

describe('automatic and manual attempts', () => {
  it('a plug-in while the chooser is open does not open the keyboard behind the user', async () => {
    const hid = new FakeHid()
    const kb = fakeDevice()
    const { result } = setup(hid)
    await settle()
    let close!: (d: HIDDevice[]) => void
    hid.requestDevice.mockImplementationOnce(() => new Promise<HIDDevice[]>((r) => (close = r)))
    let pending!: Promise<boolean>
    act(() => {
      pending = result.current.connectHid()
    })
    act(() => hid.plug(kb))
    await settle()
    expect(kb.openCalls).toBe(0)
    await act(async () => {
      close([])
      await pending
    })
    expect(result.current.ui).toMatchObject({ connected: false, busy: null })
  })
})

describe('failure messages', () => {
  it('reports a busy keyboard on auto-connect and 重试 reopens it without the chooser', async () => {
    const hid = new FakeHid()
    const kb = fakeDevice()
    kb.failOpens = 1
    hid.authorised = [kb]
    const { result } = setup(hid)
    await waitFor(() => expect(result.current.ui.failure).not.toBeNull())
    expect(result.current.ui.failure).toMatchObject({ kind: 'busy', auto: true, canRetry: true })
    expect(result.current.ui.failure!.message).toMatch(/被占用/)
    expect(result.current.ui.failure!.message).toMatch(/KB84/)
    // The browser's own (English) words are kept for 详情, not put into the message.
    expect(result.current.ui.failure!.message).not.toMatch(/Failed/)
    expect(result.current.ui.failure!.detail).toBe('Failed to open the device.')
    expect(result.current.ui.busy).toBeNull()

    await act(async () => void (await result.current.retry()))
    expect(result.current.ui).toMatchObject({ connected: true, auto: false, failure: null })
    expect(hid.requestDevice).not.toHaveBeenCalled()
  })

  it('a busy keyboard on 连接键盘 rejects with kind "busy" and leaves a retryable failure', async () => {
    const hid = new FakeHid()
    const kb = fakeDevice()
    kb.failOpens = 1
    hid.choose = [kb]
    const { result } = setup(hid)
    await settle()
    let error: unknown
    await act(async () => {
      error = await result.current.connectHid().catch((e: unknown) => e)
    })
    expect(error).toBeInstanceOf(DeviceError)
    expect((error as DeviceError).kind).toBe('busy')
    expect((error as DeviceError).message).toBe('键盘被占用：请关闭 KB84 软件或其他已连接键盘的标签页，然后点“重试”。')
    expect((error as DeviceError).detail).toBe('Failed to open the device.')
    expect(result.current.ui.failure).toMatchObject({ kind: 'busy', auto: false, canRetry: true })
    expect(result.current.ui.busy).toBeNull()

    act(() => result.current.clearFailure())
    expect(result.current.ui.failure).toBeNull()
  })

  it('stays quiet when the chooser is cancelled or denied', async () => {
    const hid = new FakeHid()
    const { result } = setup(hid)
    await settle()
    for (const choose of [[], new DOMException('No device selected.', 'NotFoundError'), new DOMException('denied', 'NotAllowedError')]) {
      hid.choose = choose
      let ok: boolean | undefined
      await act(async () => {
        ok = await result.current.connectHid()
      })
      expect(ok).toBe(false)
      expect(result.current.ui).toMatchObject({ connected: false, failure: null, busy: null })
    }
  })

  it('explains a missing or blocked WebHID', async () => {
    const { result } = setup(null)
    expect(result.current.ui.support).not.toBe('ok')
    const error = await result.current.connectHid().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeviceError)
    expect(['unsupported', 'insecure']).toContain((error as DeviceError).kind)
    expect((error as Error).message).toMatch(/Chrome|Edge/)
    expect((error as Error).message).toMatch(/localhost/)

    const hid = new FakeHid()
    hid.choose = new DOMException('blocked', 'SecurityError')
    const blocked = setup(hid)
    await settle()
    const e2 = await blocked.result.current.connectHid().catch((e: unknown) => e)
    expect((e2 as DeviceError).kind).toBe('blocked')
  })

  it('a chosen device without the configuration interface is explained without protocol terms', async () => {
    const hid = new FakeHid()
    hid.choose = [fakeDevice(0x01)]
    const { result } = setup(hid)
    await settle()
    const error = (await result.current.connectHid().catch((e: unknown) => e)) as DeviceError
    expect(error.kind).toBe('no-interface')
    expect(error.message).toBe('选中的设备不能改键。请确认选的是 84EC-S，关闭 KB84 软件后再点“连接键盘”。')
    expect(error.detail).toMatch(/0x8C/)
  })

  it('重试 without an authorised keyboard says so', async () => {
    const hid = new FakeHid()
    const { result } = setup(hid)
    await settle()
    const error = await result.current.retry().catch((e: unknown) => e)
    expect((error as DeviceError).kind).toBe('not-found')
  })
})

describe('granted', () => {
  it('is false on a first visit and true once getDevices() lists the keyboard, even with 自动连接 off', async () => {
    const first = setup(new FakeHid())
    await settle()
    expect(first.result.current.ui).toMatchObject({ granted: false, connected: false })
    first.unmount()

    const hid = new FakeHid()
    const kb = fakeDevice()
    hid.authorised = [kb]
    const off = setup(hid, { storage: memoryStorage({ [AUTO_CONNECT_KEY]: '0' }) })
    await waitFor(() => expect(off.result.current.ui.granted).toBe(true))
    expect(off.result.current.ui.connected).toBe(false)
    expect(kb.openCalls).toBe(0)
  })

  it('becomes true when an authorised keyboard is plugged in; other interfaces do not count', async () => {
    const hid = new FakeHid()
    const { result } = setup(hid, { storage: memoryStorage({ [AUTO_CONNECT_KEY]: '0' }) })
    await settle()
    act(() => hid.plug(fakeDevice(0x01)))
    expect(result.current.ui.granted).toBe(false)
    act(() => hid.plug(fakeDevice()))
    expect(result.current.ui).toMatchObject({ granted: true, connected: false })
  })

  it('becomes true once the keyboard is chosen, even if opening it then fails, and stays true after 断开', async () => {
    const hid = new FakeHid()
    const kb = fakeDevice()
    kb.failOpens = 1
    hid.choose = [kb]
    const { result } = setup(hid)
    await settle()
    expect(result.current.ui.granted).toBe(false)
    await act(async () => void (await result.current.connectHid().catch(() => undefined)))
    expect(result.current.ui).toMatchObject({ granted: true, connected: false })

    await act(async () => void (await result.current.retry()))
    expect(result.current.ui.connected).toBe(true)
    await act(() => result.current.disconnect())
    expect(result.current.ui).toMatchObject({ granted: true, connected: false, autoPaused: true })
    act(() => hid.unplug(kb))
    expect(result.current.ui.granted).toBe(true)
  })

  it('is not set by the simulator, whose name is the model (the bar adds the 模拟键盘 badge)', async () => {
    const { result } = setup(new FakeHid())
    await act(() => result.current.connectSimulator())
    expect(result.current.ui).toMatchObject({ connected: true, kind: 'simulator', name: '84EC-S', granted: false })
  })
})

describe('error wording', () => {
  const MSG_COMM = '和键盘通信出错。请关闭 KB84 软件，重新插拔键盘后再试。'

  async function simulator(kb = new SimulatedKeyboard({ latencyMs: 0 }), extra: DeviceOptions = {}) {
    const hook = setup(new FakeHid(), { createSimulator: () => kb, ...extra })
    await act(() => hook.result.current.connectSimulator())
    return { ...hook, kb }
  }
  async function failure(op: () => Promise<unknown>): Promise<DeviceError> {
    let error: unknown
    await act(async () => {
      error = await op().catch((e: unknown) => e)
    })
    expect(error).toBeInstanceOf(DeviceError)
    return error as DeviceError
  }

  it('a keyboard that does not answer is a communication error, with the protocol’s words as detail', async () => {
    const { result, kb } = await simulator(undefined, { simulatorSession: { firstTimeoutMs: 10 } })
    kb.muted = true
    const error = await failure(() => result.current.read())
    expect(error).toMatchObject({ kind: 'timeout', message: MSG_COMM })
    expect(error.detail).toMatch(/did not answer/)
    expect(result.current.ui.busy).toBeNull()
  })

  it('a rejected sendReport is a communication error', async () => {
    const hid = new FakeHid()
    const kb = fakeDevice()
    kb.sendReport = () => Promise.reject(new DOMException('Failed to write the report.', 'NotAllowedError'))
    hid.authorised = [kb]
    const { result } = setup(hid)
    await waitFor(() => expect(result.current.ui.connected).toBe(true))
    const error = await failure(() => result.current.readVersion())
    expect(error).toMatchObject({ kind: 'other', message: MSG_COMM, detail: 'Failed to write the report.' })
  })

  it('any failure of the transport counts, whatever its type', async () => {
    const { result, kb } = await simulator()
    // A plain Error out of send(), like the simulator's transport throws once it is closed.
    kb.handle = () => {
      throw new Error('Simulator transport is closed')
    }
    const error = await failure(() => result.current.read())
    expect(error).toMatchObject({ kind: 'other', message: MSG_COMM, detail: 'Simulator transport is closed' })
  })

  it('a table the page should never have sent is the page’s own error, not the keyboard’s', async () => {
    const { result } = await simulator()
    const bad = { base: [...FACTORY.base], fn: [...FACTORY.fn] }
    bad.base[0] = { kind: 'codes', codes: [0x1ffff] }
    const error = await failure(() => result.current.write(bad))
    expect(error).toMatchObject({ kind: 'internal', message: '页面内部出错。' })
    expect(error.detail).toMatch(/Invalid key slots/)
  })
})

describe('joinSentences', () => {
  it('never doubles the full stop', () => {
    expect(joinSentences('和键盘通信出错。请重试。', '键盘里的键位没有改动')).toBe('和键盘通信出错。请重试。键盘里的键位没有改动。')
    expect(joinSentences('页面内部出错。', '', undefined, null, false, '真的吗？')).toBe('页面内部出错。真的吗？')
    expect(joinSentences(' 读取失败 ')).toBe('读取失败。')
  })
})

describe('auto-connect preference storage', () => {
  it('defaults to on and survives storage that throws', async () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(loadAutoConnect(broken)).toBe(true)
    expect(loadAutoConnect(null)).toBe(true)
    expect(() => saveAutoConnect(false, broken)).not.toThrow()

    const hid = new FakeHid()
    hid.authorised = [fakeDevice()]
    const { result } = setup(hid, { storage: broken })
    await waitFor(() => expect(result.current.ui.connected).toBe(true))
    act(() => result.current.setAutoConnect(false))
    expect(result.current.ui.autoConnect).toBe(false)
  })

  it('round-trips through a storage', () => {
    const s = memoryStorage()
    saveAutoConnect(false, s)
    expect(loadAutoConnect(s)).toBe(false)
    saveAutoConnect(true, s)
    expect(loadAutoConnect(s)).toBe(true)
  })
})

describe('superseded automatic attempts (review regressions)', () => {
  /** A keyboard whose open() waits until the test settles it, and whose close() takes a while (like Chrome's IPC). */
  function slowDevice() {
    const d = fakeDevice()
    const pending: { resolve: () => void; reject: (e: unknown) => void }[] = []
    const fast = d.open.bind(d)
    d.open = () => {
      d.openCalls++
      if (pending.length === 0 && (d as unknown as { holdOpen: boolean }).holdOpen) {
        return new Promise<void>((resolve, reject) => {
          pending.push({
            resolve: () => {
              ;(d as unknown as { opened: boolean }).opened = true
              resolve()
            },
            reject,
          })
        })
      }
      d.openCalls--
      return fast()
    }
    d.close = async () => {
      await new Promise((r) => setTimeout(r, 5))
      ;(d as unknown as { opened: boolean }).opened = false
    }
    ;(d as unknown as { holdOpen: boolean }).holdOpen = true
    return { d, pending }
  }

  it('a failed automatic open superseded by a cancelled chooser does not leave "连接中" behind', async () => {
    const hid = new FakeHid()
    const { d: kb, pending } = slowDevice()
    const { result } = setup(hid, { reconnectAttempts: 1 })
    await settle()
    act(() => hid.plug(kb))
    await waitFor(() => expect(pending).toHaveLength(1))
    expect(result.current.ui.busy?.op).toBe('connect')

    // The user presses 连接键盘 and closes the chooser while the automatic open() is still running …
    hid.choose = []
    await act(async () => void (await result.current.connectHid()))
    // … and then that open() fails.
    await act(async () => {
      pending[0].reject(new DOMException('Failed to open the device.', 'InvalidStateError'))
    })
    await settle()
    expect(result.current.ui).toMatchObject({ connected: false, busy: null })
  })

  it('closing a superseded automatic connection never closes the device a manual connect then opened', async () => {
    const hid = new FakeHid()
    const { d: kb, pending } = slowDevice()
    const { result } = setup(hid, { reconnectAttempts: 1 })
    await settle()
    act(() => hid.plug(kb))
    await waitFor(() => expect(pending).toHaveLength(1))

    // 连接键盘 picks the same keyboard while the automatic open() is pending.
    hid.choose = [kb]
    let manual!: Promise<boolean>
    act(() => {
      manual = result.current.connectHid()
    })
    await settle()
    // The automatic open() succeeds after it was superseded: it must be closed before the manual attempt opens.
    let ok = false
    await act(async () => {
      pending[0].resolve()
      ok = await manual
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(ok).toBe(true)
    expect(result.current.ui).toMatchObject({ connected: true, auto: false, busy: null })
    expect(kb.opened).toBe(true)
  })
})
