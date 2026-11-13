/**
 * Wire-level model: exactly what one key slot holds inside the keyboard. One slot per (layer, key):
 * 2 layers x 84 keys = 168 slots. See docs/PROTOCOL.md for the byte encoding of each variant.
 */

/** Wire type byte p[4]: 0 = code list, 1 = emulate, 2/3/4 = macro (2 + playMode). */
export type WireType = 0 | 1 | 2 | 3 | 4

/** 0 = play `cycles` times (次数播放), 1 = play while held (按下播放，释放停止), 2 = toggle (按键开/关播放). */
export type MacroPlayMode = 0 | 1 | 2

export type Slot =
  /** Nothing assigned: `00 F0 L K 00 00`. */
  | { kind: 'empty' }
  /** Wire type 0: 1..58 codes sent together (single key, combo, media/mouse/function/power key). */
  | { kind: 'codes'; codes: number[] }
  /** Wire type 1 (模拟击键): `value` is a 16-bit speed/interval parameter (KB84 range 0..6000, default 30). */
  | { kind: 'emulate'; value: number; codes: number[] }
  /**
   * Wire types 2..4. `events` are toggle codes: the first occurrence of a code presses it, the next releases it.
   * When `hasDelays` is false the firmware waits `autoDelay` ms between events and `delays` is empty.
   * When `hasDelays` is true, `delays[i]` (0..65535 ms) is the pause between events[i] and events[i+1]
   * (delays.length === events.length - 1) and `autoDelay` is 0.
   */
  | {
      kind: 'macro'
      playMode: MacroPlayMode
      /** 1..255 for playMode 0; KB84 sends 0 for playMode 1/2. */
      cycles: number
      hasDelays: boolean
      autoDelay: number
      events: number[]
      delays: number[]
    }
  /** Anything the decoder could not interpret; kept byte-exact so it can be written back unchanged. */
  | { kind: 'raw'; packets: Uint8Array[] }

/** The complete keyboard state: index 0..83 = key number 1..84. */
export interface SlotTable {
  base: Slot[]
  fn: Slot[]
}

export const EMPTY_SLOT: Slot = Object.freeze({ kind: 'empty' }) as Slot

export function emptyTable(): SlotTable {
  return { base: Array.from({ length: 84 }, () => EMPTY_SLOT), fn: Array.from({ length: 84 }, () => EMPTY_SLOT) }
}
