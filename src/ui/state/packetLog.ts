/** Bounded log of every HID report in/out, observable from React via useSyncExternalStore (batched notifications). */
import { useSyncExternalStore } from 'react'
import type { PacketListener } from '../../transport/types'

export interface PacketEntry {
  id: number
  /** ms since the log was created */
  t: number
  dir: 'out' | 'in'
  bytes: Uint8Array
}

const LIMIT = 4000

export class PacketLog {
  private entries: PacketEntry[] = []
  private snapshot: readonly PacketEntry[] = []
  private readonly listeners = new Set<() => void>()
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly t0 = performance.now()

  readonly listener: PacketListener = (dir, payload) => {
    this.entries.push({ id: ++this.seq, t: performance.now() - this.t0, dir, bytes: payload.slice() })
    if (this.entries.length > LIMIT) this.entries.splice(0, this.entries.length - LIMIT)
    this.timer ??= setTimeout(() => this.notify(), 80)
  }

  private notify(): void {
    this.timer = null
    this.snapshot = [...this.entries]
    this.listeners.forEach((fn) => fn())
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): readonly PacketEntry[] => this.snapshot

  clear(): void {
    this.entries = []
    this.notify()
  }
}

export function usePacketLog(log: PacketLog): readonly PacketEntry[] {
  return useSyncExternalStore(log.subscribe, log.getSnapshot)
}

export const hexBytes = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ')
