/**
 * Connection to a real keyboard (WebHID) or the simulator, and the long-running operations on it.
 * Operations report progress through `busy`; errors are thrown to the caller, which turns them into notices.
 *
 * Auto-connect: on mount the hook asks navigator.hid.getDevices() for keyboards this origin was already allowed to use
 * and, when there is exactly one 84EC-S configuration interface, opens it without the chooser. A 'connect' event for
 * an authorised keyboard (it was plugged in again) reconnects the same way. Pressing 断开 pauses auto-connect for the
 * rest of the page session, until the user presses 连接键盘 again. The on/off preference lives in localStorage.
 *
 * Errors reach the UI as DeviceError: a Chinese message for the user, the browser's or the protocol's own words in
 * `detail` (shown under 详情), never on the main path.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { DEVICE_MODEL } from '../../device/types'
import {
  DeviceTimeoutError,
  KeyboardSession,
  type SessionOptions,
  type SessionReadResult,
  type WriteResult,
} from '../../protocol/session'
import type { SlotTable } from '../../protocol/slots'
import { SimulatedKeyboard, SimulatorTransport, type KeyboardMode } from '../../transport/simulator'
import { TimeoutError, type Transport } from '../../transport/types'
import {
  classifyOpenError,
  configDevices,
  HID_FILTERS,
  isChooserDismissal,
  isKeyboardInterface,
  isWebHidSupported,
  pickConfigDevice,
  webHidSupport,
  WebHidTransport,
  type HidSupport,
} from '../../transport/webhid'
import type { PacketLog } from './packetLog'

export type BusyOp = 'connect' | 'read' | 'write' | 'verify' | 'version'

export interface Busy {
  op: BusyOp
  done: number
  total: number
}

/** What went wrong, so the UI can pick wording and offer 重试 only where it helps. */
export type DeviceErrorKind =
  | 'busy' // open() rejected: KB84 or another tab holds the keyboard
  | 'denied' // the browser refused to open a device it had allowed before
  | 'unsupported' // no WebHID in this browser
  | 'insecure' // WebHID hidden because the page is not HTTPS / localhost
  | 'blocked' // the chooser was blocked (permissions policy, e.g. inside an iframe)
  | 'no-interface' // the keyboard was chosen but its 0x8C configuration interface is missing
  | 'not-found' // 重试 found no authorised keyboard
  | 'timeout' // the keyboard did not answer a command
  | 'internal' // the page itself went wrong (a bug, or a table it should never have sent), not the keyboard
  | 'other'

/** A user-facing error with a Chinese explanation; `detail` keeps the original (often English) text for 详情. */
export class DeviceError extends Error {
  readonly kind: DeviceErrorKind
  readonly detail?: string
  constructor(message: string, kind: DeviceErrorKind = 'other', detail?: string) {
    super(message)
    this.name = 'DeviceError'
    this.kind = kind
    if (detail) this.detail = detail
  }
}

/**
 * Joins Chinese sentences into one message. Every message here already ends with 。, so a part only gets one when it
 * has no closing punctuation: never 「……。。」.
 */
export function joinSentences(...parts: (string | null | undefined | false)[]): string {
  return parts
    .map((p) => (p || '').trim())
    .filter(Boolean)
    .map((p) => (/[。！？…]$/.test(p) ? p : `${p}。`))
    .join('')
}

/** The last failed attempt to open the keyboard; cleared by any successful connection, 断开 or the simulator. */
export interface ConnectFailure {
  kind: DeviceErrorKind
  message: string
  /** The attempt was automatic (page load or plug-in), not a click. */
  auto: boolean
  /** 重试 (reopen without the chooser) can help. */
  canRetry: boolean
  /** The browser's own words, for 详情. */
  detail?: string
}

export interface DeviceUi {
  connected: boolean
  kind: 'webhid' | 'simulator' | null
  name: string
  /**
   * Firmware version (F9 reply as text, or hex when not printable); null = the keyboard did not answer; undefined = not
   * asked. F9 is only sent when the user asks for it (docs/PROTOCOL.md §11, §18 rule 7).
   */
  version: string | null | undefined
  simMode: KeyboardMode | null
  busy: Busy | null
  /** Whether a real keyboard can be used in this page at all. */
  support: HidSupport
  /** The current connection was opened automatically (page load or plug-in). */
  auto: boolean
  /** The persisted 自动连接 preference (default on). */
  autoConnect: boolean
  /** The user pressed 断开 in this page session; auto-connect waits until they press 连接键盘 again. */
  autoPaused: boolean
  /**
   * This page may already open a keyboard without the chooser: getDevices() listed one on load or when it was plugged
   * in, or one was chosen or connected in this page session. Stays true after 断开 and unplugging. False on a first
   * visit (and when the authorised keyboard is not plugged in yet), so "插上键盘会自动连接" is not promised then.
   */
  granted: boolean
  failure: ConnectFailure | null
}

/** The subset of Storage the preference needs (tests pass a Map-backed fake, or null for "no storage"). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface DeviceOptions {
  /** Creates the simulated keyboard (tests inject one with zero latency). */
  createSimulator?: () => SimulatedKeyboard
  session?: SessionOptions
  simulatorSession?: SessionOptions
  /** The keyboard was unplugged while connected. */
  onUnplugged?: () => void
  /** A keyboard was connected automatically (no click), on page load or when it was plugged in. */
  onAutoConnected?: (name: string) => void
  /** WebHID entry point; defaults to navigator.hid when present. null = behave as if WebHID is missing. */
  hid?: HID | null
  /** Where the 自动连接 preference is kept; defaults to localStorage (when accessible). null = not persisted. */
  storage?: StorageLike | null
  /** After a 'connect' event the keyboard may need a moment before open() works: tries this many times… */
  reconnectAttempts?: number
  /** …this far apart (ms). */
  reconnectDelayMs?: number
}

export const AUTO_CONNECT_KEY = 'plum-kb84.autoConnect'

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/** The 自动连接 preference; true unless it was switched off. Never throws. */
export function loadAutoConnect(storage: StorageLike | null | undefined = defaultStorage()): boolean {
  try {
    return storage?.getItem(AUTO_CONNECT_KEY) !== '0'
  } catch {
    return true
  }
}

/** Stores the 自动连接 preference; silently does nothing when storage is unavailable. */
export function saveAutoConnect(on: boolean, storage: StorageLike | null | undefined = defaultStorage()): void {
  try {
    storage?.setItem(AUTO_CONNECT_KEY, on ? '1' : '0')
  } catch {
    // private mode, blocked site data, quota: the toggle still works for this page session
  }
}

const IDLE = { connected: false, kind: null, name: '', version: undefined, simMode: null, busy: null, auto: false } as const

interface Conn {
  transport: Transport
  session: KeyboardSession
  hid?: HIDDevice
  sim?: SimulatedKeyboard
}

const MSG_UNSUPPORTED = '当前浏览器不支持 WebHID。请使用桌面版 Chrome 或 Edge，并通过 HTTPS 或 localhost 打开本页。'
const MSG_INSECURE =
  '本页不是通过安全连接打开的，浏览器因此关闭了 WebHID。请改用 https:// 地址，或在本机用 http://localhost 打开（需要桌面版 Chrome 或 Edge）。'
const MSG_BLOCKED = '浏览器阻止了设备选择窗口（页面可能被嵌入在不允许 WebHID 的框架里）。请在新标签页中直接打开本页再试。'
const MSG_NO_INTERFACE = '选中的设备不能改键。请确认选的是 84EC-S，关闭 KB84 软件后再点“连接键盘”。'
const DETAIL_NO_INTERFACE =
  '没有找到配置接口（usage page 0x8C，64 字节输入/输出报告）。如果型号确实是 84EC-S，可能是当前系统的浏览器没有提供这个接口。'
const MSG_NOT_FOUND = '没有找到已授权的键盘。请确认键盘已插好，然后点“连接键盘”。'
const MSG_DENIED = '浏览器不允许打开这把键盘，之前的授权可能已被撤销。请点“连接键盘”重新授权。'
const MSG_BUSY = '键盘被占用：请关闭 KB84 软件或其他已连接键盘的标签页，然后点“重试”。'
const MSG_COMM = '和键盘通信出错。请关闭 KB84 软件，重新插拔键盘后再试。'
const MSG_INTERNAL = '页面内部出错。'

/** The original text of whatever was thrown, for 详情 (a DOMException is not an Error everywhere, e.g. in jsdom). */
function detailOf(e: unknown): string {
  const { message, name } = (e ?? {}) as { message?: unknown; name?: unknown }
  if (typeof message === 'string' && message) return message
  return typeof name === 'string' && name ? name : String(e)
}

function openError(e: unknown): DeviceError {
  const detail = detailOf(e)
  return classifyOpenError(e) === 'denied' ? new DeviceError(MSG_DENIED, 'denied', detail) : new DeviceError(MSG_BUSY, 'busy', detail)
}

/** Rejections of the session's own send()/receive(), whatever their type: those are failures of the link itself. */
const linkErrors = new WeakSet<object>()

/** The transport as the session sees it: the same calls, with every failure remembered as a link failure. */
function marked(t: Transport): Transport {
  const mark = (e: unknown): never => {
    if (typeof e === 'object' && e !== null) linkErrors.add(e)
    throw e
  }
  return {
    info: t.info,
    send: (payload) => t.send(payload).catch(mark),
    receive: (timeoutMs) => t.receive(timeoutMs).catch(mark),
    flush: () => t.flush(),
    close: () => t.close(),
  }
}

/**
 * Turns whatever an operation threw into a DeviceError. Only failures of the link to the keyboard (no answer, a
 * rejected sendReport, a closed device) send the user to KB84 and the cable; anything else is the page's own fault
 * (e.g. a slot that fails validation before the write starts), and blaming the keyboard would mislead.
 */
function friendly(e: unknown): DeviceError {
  if (e instanceof DeviceError) return e
  const detail = detailOf(e)
  if (e instanceof DeviceTimeoutError || e instanceof TimeoutError) return new DeviceError(MSG_COMM, 'timeout', detail)
  const link = (typeof e === 'object' && e !== null && linkErrors.has(e)) || (typeof DOMException !== 'undefined' && e instanceof DOMException)
  return link ? new DeviceError(MSG_COMM, 'other', detail) : new DeviceError(MSG_INTERNAL, 'internal', detail)
}

const printable = (s: string) => /^[\x20-\x7e]{1,48}$/.test(s.trim())

/** Version reply bytes after the 2-byte header (trailing zeros dropped, at most 16) as hex. */
function versionHex(raw: Uint8Array): string {
  let end = raw.length
  while (end > 2 && raw[end - 1] === 0) end--
  const bytes = Array.from(raw.subarray(2, Math.min(end, 18)), (b) => b.toString(16).padStart(2, '0').toUpperCase())
  return bytes.length ? `hex ${bytes.join(' ')}` : '（空回复）'
}

/**
 * Display name. Windows reports the configuration interface's own string ("Program"; the others are e.g. "System
 * Control"), not the keyboard's, so anything that does not name the model is shown as the model.
 */
const nameOf = (d: HIDDevice) => (/84EC/i.test(d.productName ?? '') ? d.productName : DEVICE_MODEL)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function useDevice(log: PacketLog, opts: DeviceOptions = {}) {
  // The WebHID entry point and storage are fixed for the lifetime of the hook.
  const [hid] = useState<HID | null>(() =>
    opts.hid !== undefined ? opts.hid : isWebHidSupported() ? navigator.hid : null,
  )
  const [storage] = useState<StorageLike | null>(() => (opts.storage !== undefined ? opts.storage : defaultStorage()))
  const [ui, setUi] = useState<DeviceUi>(() => ({
    ...IDLE,
    support: hid ? 'ok' : webHidSupport() === 'insecure' ? 'insecure' : 'unsupported',
    autoConnect: loadAutoConnect(storage),
    autoPaused: false,
    granted: false,
    failure: null,
  }))
  const conn = useRef<Conn | null>(null)
  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })
  const autoPref = useRef(ui.autoConnect)
  const paused = useRef(false)
  /** Bumped by every user action and on unmount; an older automatic attempt that sees a newer value gives up. */
  const epoch = useRef(0)
  /** Only the newest automatic attempt may open the keyboard. */
  const autoSeq = useRef(0)
  /** The open() in flight, so a second one never races it on the same device. */
  const pendingOpen = useRef<Promise<unknown> | null>(null)
  /** The keyboard the last attempt tried to open, for 重试. */
  const lastDevice = useRef<HIDDevice | null>(null)
  /** 连接键盘 / 重试 in progress (the chooser may be open); automatic attempts keep out of the way meanwhile. */
  const manual = useRef(0)

  const patch = useCallback((p: Partial<DeviceUi>) => setUi((u) => ({ ...u, ...p })), [])
  const markGranted = useCallback(() => setUi((u) => (u.granted ? u : { ...u, granted: true })), [])
  /** Drops a 'connect' busy marker left by an attempt that was superseded before it could finish. */
  const settleConnectBusy = useCallback(
    () => setUi((u) => (u.busy?.op === 'connect' && !pendingOpen.current && !conn.current ? { ...u, busy: null } : u)),
    [],
  )

  const teardown = useCallback(async () => {
    const c = conn.current
    conn.current = null
    setUi((u) => ({ ...u, ...IDLE }))
    if (c) await c.transport.close().catch(() => undefined)
  }, [])

  const run = useCallback(
    async <T,>(op: BusyOp, fn: (c: Conn) => Promise<T>): Promise<T> => {
      const c = conn.current
      if (!c) throw new DeviceError('还没有连接键盘。')
      patch({ busy: { op, done: 0, total: 0 } })
      try {
        return await fn(c)
      } catch (e) {
        throw friendly(e)
      } finally {
        patch({ busy: null })
      }
    },
    [patch],
  )

  const afterConnect = useCallback((c: Conn, name: string, auto: boolean) => {
    conn.current = c
    setUi((u) => ({
      ...u,
      connected: true,
      kind: c.transport.info.kind,
      name,
      version: undefined,
      simMode: c.sim?.getMode() ?? null,
      busy: null,
      auto,
      granted: u.granted || !!c.hid,
      failure: null,
    }))
  }, [])

  /**
   * Opens `device` and makes it the connection. Returns false when a newer user action superseded this attempt (the
   * device is closed again). Open failures are recorded in `ui.failure` and thrown as DeviceError.
   */
  const openAndAdopt = useCallback(
    async (device: HIDDevice, auto: boolean, attempts: number, token: number): Promise<boolean> => {
      await pendingOpen.current?.catch(() => undefined)
      if (token !== epoch.current || (auto && conn.current)) return false
      if (!auto) await teardown()
      lastDevice.current = device
      patch({ busy: { op: 'connect', done: 0, total: 0 }, failure: null })
      // A superseded attempt closes what it opened *inside* the tracked promise: the next attempt waits for that close
      // to finish, so it never adopts a device that is about to be closed under it.
      const attempt = (async (): Promise<WebHidTransport | null> => {
        let last: unknown
        for (let i = 0; i < attempts; i++) {
          if (i > 0) await sleep(optsRef.current.reconnectDelayMs ?? 500)
          if (token !== epoch.current) return null
          let t: WebHidTransport
          try {
            t = await WebHidTransport.open(device, nameOf(device), log.listener)
          } catch (e) {
            last = e
            if (classifyOpenError(e) === 'denied') break
            continue
          }
          if (token !== epoch.current) {
            await t.close().catch(() => undefined)
            return null
          }
          return t
        }
        throw last
      })()
      pendingOpen.current = attempt
      const release = () => {
        if (pendingOpen.current === attempt) pendingOpen.current = null
      }
      let transport: WebHidTransport | null
      try {
        transport = await attempt
      } catch (e) {
        release()
        const err = openError(e)
        if (token === epoch.current)
          patch({
            busy: null,
            failure: { kind: err.kind, message: err.message, auto, canRetry: err.kind === 'busy', detail: err.detail },
          })
        // Superseded: whoever superseded it may already have finished (a cancelled chooser), so drop our marker.
        else settleConnectBusy()
        throw err
      }
      release()
      if (!transport || token !== epoch.current) {
        await transport?.close().catch(() => undefined)
        settleConnectBusy()
        return false
      }
      const session = new KeyboardSession(marked(transport), optsRef.current.session)
      afterConnect({ transport, session, hid: device }, nameOf(device), auto)
      if (auto) optsRef.current.onAutoConnected?.(nameOf(device))
      return true
    },
    [afterConnect, log, patch, settleConnectBusy, teardown],
  )

  /**
   * One automatic attempt: `candidate` from a 'connect' event, otherwise the single authorised keyboard from
   * getDevices(). Quiet: never throws; open failures land in `ui.failure`.
   */
  const tryAuto = useCallback(
    async (candidate?: HIDDevice): Promise<boolean> => {
      if (!hid || !autoPref.current || paused.current || conn.current || manual.current) return false
      const seq = ++autoSeq.current
      const token = epoch.current
      try {
        let device = candidate
        if (device) {
          if (!pickConfigDevice([device])) return false
        } else {
          const found = configDevices(await hid.getDevices())
          if (found.length !== 1) return false
          device = found[0]
        }
        if (seq !== autoSeq.current || token !== epoch.current) return false
        if (!autoPref.current || paused.current || conn.current || manual.current) return false
        const attempts = candidate ? Math.max(1, optsRef.current.reconnectAttempts ?? 3) : 1
        return await openAndAdopt(device, true, attempts, token)
      } catch (e) {
        // A permission problem on an automatic attempt stays quiet; the user can still press 连接键盘.
        if (e instanceof DeviceError && e.kind === 'denied' && token === epoch.current) patch({ failure: null })
        return false
      }
    },
    [hid, openAndAdopt, patch],
  )

  const connectHidOnce = useCallback(async () => {
    const token = ++epoch.current
    // Pressing 连接键盘 lifts the pause that 断开 put on auto-connect.
    paused.current = false
    patch({ autoPaused: false, failure: null })
    if (!hid) {
      const insecure = webHidSupport() === 'insecure'
      throw new DeviceError(insecure ? MSG_INSECURE : MSG_UNSUPPORTED, insecure ? 'insecure' : 'unsupported')
    }
    // Ask first (needs the click's user activation); a cancelled chooser keeps the current connection.
    let devices: HIDDevice[]
    try {
      devices = await hid.requestDevice({ filters: [...HID_FILTERS] })
    } catch (e) {
      settleConnectBusy()
      if (isChooserDismissal(e)) return false
      if ((e as { name?: unknown } | null)?.name === 'SecurityError') throw new DeviceError(MSG_BLOCKED, 'blocked', detailOf(e))
      throw friendly(e)
    }
    settleConnectBusy()
    if (devices.length === 0) return false
    // The chooser may hand back every interface of the keyboard; configuration goes only through the 0x8C collection
    // with 64-byte reports (KB84 accepts only mi_01). There is deliberately no fallback to other collections.
    const all = [...devices, ...(await hid.getDevices()).filter(isKeyboardInterface)]
    const device = pickConfigDevice(all)
    if (!device) throw new DeviceError(MSG_NO_INTERFACE, 'no-interface', DETAIL_NO_INTERFACE)
    // Chosen once, it can be opened without the chooser from now on, even if this open fails.
    markGranted()
    return openAndAdopt(device, false, 1, token)
  }, [hid, markGranted, openAndAdopt, patch, settleConnectBusy])

  /** 重试 after a failed open: reopens the same keyboard without the chooser (open() needs no click). */
  const retryOnce = useCallback(async (): Promise<boolean> => {
    const token = ++epoch.current
    paused.current = false
    patch({ autoPaused: false })
    if (!hid) {
      const insecure = webHidSupport() === 'insecure'
      throw new DeviceError(insecure ? MSG_INSECURE : MSG_UNSUPPORTED, insecure ? 'insecure' : 'unsupported')
    }
    const found = configDevices(await hid.getDevices())
    let device = lastDevice.current
    if (!device || !found.includes(device)) device = found.length === 1 ? found[0] : null
    if (!device) {
      patch({ failure: null })
      throw new DeviceError(MSG_NOT_FOUND, 'not-found')
    }
    return openAndAdopt(device, false, 1, token)
  }, [hid, openAndAdopt, patch])

  const manually = useCallback(async (fn: () => Promise<boolean>): Promise<boolean> => {
    manual.current++
    try {
      return await fn()
    } finally {
      manual.current--
    }
  }, [])
  /** 连接键盘: the chooser, then the configuration interface. false = the chooser was closed (no message needed). */
  const connectHid = useCallback(() => manually(connectHidOnce), [connectHidOnce, manually])
  const retry = useCallback(() => manually(retryOnce), [manually, retryOnce])

  const connectSimulator = useCallback(async () => {
    epoch.current++
    await teardown()
    patch({ failure: null })
    const kb = optsRef.current.createSimulator?.() ?? new SimulatedKeyboard({ latencyMs: 2 })
    const transport = new SimulatorTransport(kb, log.listener)
    const session = new KeyboardSession(marked(transport), { postWriteDelayMs: 400, ...optsRef.current.simulatorSession })
    // The bar's 模拟键盘 badge says it is simulated; the name is the model, as for a real keyboard.
    afterConnect({ transport, session, sim: kb }, DEVICE_MODEL, false)
  }, [afterConnect, log, patch, teardown])

  /** The user's 断开: closes the connection and pauses auto-connect until 连接键盘 is pressed again. */
  const disconnect = useCallback(async () => {
    epoch.current++
    paused.current = true
    patch({ autoPaused: true, failure: null })
    await teardown()
  }, [patch, teardown])

  const setAutoConnect = useCallback(
    (on: boolean) => {
      autoPref.current = on
      saveAutoConnect(on, storage)
      patch({ autoConnect: on })
      if (on) void tryAuto()
    },
    [patch, storage, tryAuto],
  )

  const clearFailure = useCallback(() => patch({ failure: null }), [patch])

  // Plug and unplug.
  useEffect(() => {
    if (!hid) return
    const onDisconnect = (e: HIDConnectionEvent) => {
      if (conn.current?.hid && e.device === conn.current.hid) {
        void teardown()
        optsRef.current.onUnplugged?.()
      } else if (!conn.current && e.device === lastDevice.current) {
        // The keyboard a failed attempt was about is gone; its message no longer applies.
        setUi((u) => (u.failure ? { ...u, failure: null } : u))
      }
    }
    const onConnect = (e: HIDConnectionEvent) => {
      // 'connect' only fires for keyboards this page is allowed to open, so it is granted even with 自动连接 off.
      if (pickConfigDevice([e.device])) markGranted()
      void tryAuto(e.device)
    }
    hid.addEventListener('disconnect', onDisconnect)
    hid.addEventListener('connect', onConnect)
    return () => {
      hid.removeEventListener('disconnect', onDisconnect)
      hid.removeEventListener('connect', onConnect)
    }
  }, [hid, markGranted, teardown, tryAuto])

  // Auto-connect on page load, after the first paint, and find out whether a keyboard is already granted (also with
  // 自动连接 off, so the bar does not ask a returning user to choose it again). The cleanup cancels the timer and bumps
  // the epoch, so a StrictMode re-mount or an unmount abandons an attempt that is already waiting for getDevices().
  useEffect(() => {
    const epochRef = epoch
    const timer = setTimeout(() => {
      hid?.getDevices().then((found) => configDevices(found).length > 0 && markGranted(), () => undefined)
      void tryAuto()
    }, 0)
    return () => {
      clearTimeout(timer)
      epochRef.current++
    }
  }, [hid, markGranted, tryAuto])

  useEffect(() => () => void conn.current?.transport.close(), [])

  const read = useCallback(
    (): Promise<SessionReadResult> =>
      run('read', (c) => c.session.readAll((done, total) => patch({ busy: { op: 'read', done, total } }))),
    [patch, run],
  )

  const write = useCallback(
    (table: SlotTable): Promise<WriteResult> =>
      run('write', (c) =>
        c.session.writeAll(table, {
          verify: true,
          onProgress: (done, total) => patch({ busy: { op: done === total ? 'verify' : 'write', done, total } }),
        }),
      ),
    [patch, run],
  )

  /** Reads again for "重新校验" (after switching to Program mode). */
  const verifyRead = useCallback(
    (): Promise<SessionReadResult> =>
      run('verify', (c) => c.session.readAll((done, total) => patch({ busy: { op: 'verify', done, total } }))),
    [patch, run],
  )

  /** Firmware version (F9), only on request. */
  const readVersion = useCallback(
    () =>
      run('version', async (c) => {
        const v = await c.session.readVersion()
        const version = v ? (printable(v.text) ? v.text.trim() : versionHex(v.raw)) : null
        if (conn.current === c) patch({ version })
        return version
      }),
    [patch, run],
  )

  const setSimMode = useCallback(
    (mode: KeyboardMode) => {
      conn.current?.sim?.setMode(mode)
      patch({ simMode: mode })
    },
    [patch],
  )

  return {
    ui,
    connectHid,
    connectSimulator,
    disconnect,
    read,
    write,
    verifyRead,
    readVersion,
    setSimMode,
    retry,
    setAutoConnect,
    clearFailure,
  }
}

export type DeviceApi = ReturnType<typeof useDevice>
