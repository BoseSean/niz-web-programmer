import { CONFIG_USAGE, CONFIG_USAGE_PAGE, USB_PRODUCT_ID, USB_VENDOR_ID } from '../device/types'
import {
  REPORT_SIZE,
  ReportQueue,
  toReport,
  type PacketListener,
  type Transport,
  type TransportInfo,
} from './types'

export function isWebHidSupported(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator
}

/**
 * Why WebHID can or cannot be used here. Browsers expose navigator.hid only in secure contexts (HTTPS, localhost), so
 * a missing navigator.hid on a plain-http page is 'insecure', not 'unsupported' (PROTOCOL.md §2).
 */
export type HidSupport = 'ok' | 'insecure' | 'unsupported'

export function webHidSupport(): HidSupport {
  if (isWebHidSupported()) return 'ok'
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure'
  return 'unsupported'
}

/** Chooser filters: the configuration collection first, then any interface of the keyboard (PROTOCOL.md §2). */
export const HID_FILTERS: readonly HIDDeviceFilter[] = [
  { vendorId: USB_VENDOR_ID, productId: USB_PRODUCT_ID, usagePage: CONFIG_USAGE_PAGE, usage: CONFIG_USAGE },
  { vendorId: USB_VENDOR_ID, productId: USB_PRODUCT_ID },
]

/** True for any HID interface of an 84EC-S (0483:5025), configuration interface or not. */
export function isKeyboardInterface(device: HIDDevice): boolean {
  return device.vendorId === USB_VENDOR_ID && device.productId === USB_PRODUCT_ID
}

/**
 * Why HIDDevice.open() failed. Chrome rejects with a DOMException ("Failed to open the device.", usually
 * InvalidStateError or NetworkError) without saying why; on Windows the usual cause is another program (KB84) or
 * another browser tab holding the interface, so everything except a permission error is reported as 'busy'.
 */
export type OpenFailure = 'busy' | 'denied'

export function classifyOpenError(e: unknown): OpenFailure {
  const name = (e as { name?: unknown } | null)?.name
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'busy'
}

/** requestDevice() rejections that only mean "the user closed the chooser / said no"; they deserve no message. */
export function isChooserDismissal(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name
  return name === 'NotFoundError' || name === 'NotAllowedError' || name === 'AbortError'
}

/** Byte length of a HID report described by WebHID collection info. */
function reportBytes(report: HIDReportInfo): number {
  let bits = 0
  for (const item of report.items ?? []) bits += (item.reportSize ?? 0) * (item.reportCount ?? 0)
  return Math.ceil(bits / 8)
}

/**
 * The keyboard exposes several HID interfaces (keyboard, consumer, ...). KB84 talks to exactly one: the device path
 * with vid_0483, pid_5025 and mi_01 (KB84HWI 0x10002420, REA ev_15f688a3…). WebHID has no interface number, so the
 * configuration interface is the one whose collection has usage page 0x8C **and** 64-byte input and output reports
 * with report id 0 (PROTOCOL.md §2). Both conditions must hold on the same collection.
 */
export function isConfigInterface(device: HIDDevice): boolean {
  return device.collections.some(c => {
    if (c.usagePage !== CONFIG_USAGE_PAGE) return false
    const out = (c.outputReports ?? []).some(r => (r.reportId ?? 0) === 0 && reportBytes(r) === REPORT_SIZE)
    const inp = (c.inputReports ?? []).some(r => (r.reportId ?? 0) === 0 && reportBytes(r) === REPORT_SIZE)
    return out && inp
  })
}

/** The 84EC-S configuration interface among the HIDDevices the browser returned, or undefined (no fallback). */
export function pickConfigDevice(devices: readonly HIDDevice[]): HIDDevice | undefined {
  return devices.find(d => isKeyboardInterface(d) && isConfigInterface(d))
}

/** Every distinct 84EC-S configuration interface among the given HIDDevices (one per authorised keyboard). */
export function configDevices(devices: readonly HIDDevice[]): HIDDevice[] {
  return [...new Set(devices.filter(d => isKeyboardInterface(d) && isConfigInterface(d)))]
}

export class WebHidTransport implements Transport {
  readonly info: TransportInfo
  private readonly device: HIDDevice
  private readonly queue = new ReportQueue()
  private readonly listener: PacketListener | undefined
  private readonly onInput = (e: HIDInputReportEvent) => {
    if (e.reportId !== 0) return
    // KB84 always reads whole 65-byte reports (report id + 64). Anything else is not protocol traffic: drop it here
    // instead of padding it into a plausible-looking payload.
    if (e.data.byteLength !== REPORT_SIZE) {
      console.warn(`WebHID: ignored a ${e.data.byteLength}-byte input report (expected ${REPORT_SIZE})`)
      return
    }
    const payload = new Uint8Array(e.data.buffer, e.data.byteOffset, REPORT_SIZE).slice()
    this.listener?.('in', payload)
    this.queue.push(payload)
  }

  private constructor(device: HIDDevice, name: string, listener?: PacketListener) {
    this.device = device
    this.listener = listener
    this.info = { name, vendorId: device.vendorId, productId: device.productId, kind: 'webhid' }
    device.addEventListener('inputreport', this.onInput)
  }

  static async open(device: HIDDevice, name: string, listener?: PacketListener): Promise<WebHidTransport> {
    if (!device.opened) await device.open()
    return new WebHidTransport(device, name, listener)
  }

  async send(payload: Uint8Array): Promise<void> {
    const report = toReport(payload)
    this.listener?.('out', report)
    await this.device.sendReport(0, report as Uint8Array<ArrayBuffer>)
  }

  receive(timeoutMs: number): Promise<Uint8Array> {
    return this.queue.next(timeoutMs)
  }

  flush(): void {
    this.queue.clear()
  }

  async close(): Promise<void> {
    this.device.removeEventListener('inputreport', this.onInput)
    if (this.device.opened) await this.device.close()
  }
}
