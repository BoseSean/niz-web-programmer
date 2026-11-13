/**
 * A transport moves fixed-size 64-byte HID report payloads between the app and a keyboard.
 * The report-id byte (always 0 for this device family) is handled by the transport, never by callers.
 */
export const REPORT_SIZE = 64

export interface TransportInfo {
  /** Human readable product name, e.g. "Mini84" */
  name: string
  vendorId: number
  productId: number
  /** "webhid" for a real keyboard, "simulator" for the in-memory device */
  kind: 'webhid' | 'simulator'
}

export interface Transport {
  readonly info: TransportInfo
  /** Send one 64-byte payload (shorter payloads are zero-padded). */
  send(payload: Uint8Array): Promise<void>
  /** Wait for the next 64-byte payload from the device. Rejects with TimeoutError after `timeoutMs`. */
  receive(timeoutMs: number): Promise<Uint8Array>
  /** Drop any input reports that arrived but were not consumed yet. */
  flush(): void
  close(): Promise<void>
}

export class TimeoutError extends Error {
  constructor(message = 'Timed out waiting for the keyboard to answer') {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** Observer for the packet log panel. */
export type PacketListener = (direction: 'out' | 'in', payload: Uint8Array) => void

/** Pads/truncates to exactly REPORT_SIZE bytes. */
export function toReport(payload: Uint8Array): Uint8Array {
  if (payload.length === REPORT_SIZE) return payload
  const out = new Uint8Array(REPORT_SIZE)
  out.set(payload.subarray(0, REPORT_SIZE))
  return out
}

/**
 * FIFO of received payloads with promise-based waiting; shared by the WebHID and simulator transports.
 */
export class ReportQueue {
  private items: Uint8Array[] = []
  private waiters: Array<(p: Uint8Array) => void> = []

  push(payload: Uint8Array): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(payload)
    else this.items.push(payload)
  }

  next(timeoutMs: number): Promise<Uint8Array> {
    const ready = this.items.shift()
    if (ready) return Promise.resolve(ready)
    return new Promise((resolve, reject) => {
      const waiter = (p: Uint8Array) => {
        clearTimeout(timer)
        resolve(p)
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter)
        reject(new TimeoutError())
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  clear(): void {
    this.items = []
  }
}
