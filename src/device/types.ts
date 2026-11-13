/**
 * Static description of the supported keyboard: NIZ / Plum 84EC-S (USB 0483:5025), the board programmed by
 * NIZ's "KB84 Programming Software". Data modules (codes.ts, layout.ts) are generated from docs/re/*.json.
 */

/** UI category of a device code, mirroring the KB84 key-settings tabs. */
export type CodeCategory = 'key' | 'media' | 'mouse' | 'function' | 'power' | 'special'

export interface CodeInfo {
  /** Device code (1 byte on the wire; KB84 calls it HWCode). 199 is a pseudo-code, see `wire`. */
  value: number
  /** Canonical identifier used in profiles. Keyboard keys use KeyboardEvent.code names (e.g. "KeyA"). */
  id: string
  category: CodeCategory
  /** Bytes actually sent for a single-code action (normally [value]; double click is [130, 130]). */
  wire: number[]
  /** Short label for a key cap (fits ~1u), e.g. "A", "Esc", "Vol+". */
  short: string
  /** Display names. */
  zh: string
  en: string
  /** Label the KB84 .pro format uses for this code inside lists (null if KB84 cannot express it in a list). */
  proLabel: string | null
  /** KB84 "Mode" (UI tab) for a single-code key: 1 key, 5 media, 6 mouse, 7 function, 8 power. */
  kb84Mode: number
  /** Optional description / caveat shown in the UI (e.g. "meaning on 84EC-S unverified"). */
  note?: string
  /** True when KB84 offers it in a picker (false = only preserved when read from the device). */
  pickable: boolean
}

/** One physical key. `no` is the device key number (1..84, row-major), used on the wire and in .pro files. */
export interface KeyInfo {
  /** Stable physical-key identifier used in profiles, e.g. "esc", "caps", "lshift", "1". */
  id: string
  no: number
  /** Legend printed on the cap. */
  label: string
  /** Secondary (Fn-layer) legend printed on the cap, if any. */
  sub?: string
  /** Geometry in key units (1u = one alpha key); the board is 16u x 6u. */
  x: number
  y: number
  w: number
  row: number
}

export type LayerId = 'base' | 'fn'
export const LAYERS: readonly LayerId[] = ['base', 'fn'] as const
/** Wire layer number: 1 = normal ("上档键"), 2 = Fn ("下档键"). */
export const WIRE_LAYER: Record<LayerId, 1 | 2> = { base: 1, fn: 2 }

export const DEVICE_MODEL = '84EC-S' as const
export const USB_VENDOR_ID = 0x0483
export const USB_PRODUCT_ID = 0x5025
/** HID collection of the configuration interface (MI_01). */
export const CONFIG_USAGE_PAGE = 0x008c
export const CONFIG_USAGE = 0x0001
export const KEY_COUNT = 84
