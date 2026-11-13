/**
 * Plum Keymap — the intermediate, human-editable description of how the keyboard is programmed.
 * JSON Schema: /format/plum-keymap.schema.json. Spec: /docs/FORMAT.md.
 *
 * A profile describes, for each physical key on each layer, what the key does. It compiles 1:1 into the device's
 * 168 slots (protocol/slots.ts) and can be produced back from a device read or from a KB84 .pro file.
 */
import type { LayerId } from '../device/types'

/**
 * A device code: its canonical id (e.g. "KeyA", "ShiftLeft", "MediaPlayPause", "MouseLeft", "Fn", "Sleep") or the raw
 * numeric code 1..255 (used for device functions that have no name, e.g. 160).
 */
export type CodeRef = string | number

export type MacroPlay = 'repeat' | 'hold' | 'toggle'

/** One macro step. `down`/`up` press or release a code; `tap` = down then up; `wait` pauses (ms). */
export type MacroStep = { down: CodeRef } | { up: CodeRef } | { tap: CodeRef } | { wait: number }

export type Action =
  /** The key does nothing on this layer. */
  | { type: 'none' }
  /** One code: a normal key, or a media / mouse / function / power key, or a raw device code. */
  | { type: 'key'; code: CodeRef }
  /** 2..6 codes pressed together (组合键), e.g. ["ControlLeft", "ShiftLeft", "Escape"]. */
  | { type: 'combo'; keys: CodeRef[] }
  /**
   * 宏定义. `play`: "repeat" plays it `repeat` (1..255) times, "hold" plays while the key is held, "toggle" starts/stops
   * on each press. Timing: with `interval` (0..60000 ms) every step is separated by that fixed delay and `wait` steps
   * are not allowed; without `interval` the `wait` steps give the exact delays (recorded timing).
   */
  | { type: 'macro'; play: MacroPlay; repeat?: number; interval?: number; steps: MacroStep[] }
  /** 模拟击键: rapidly repeats 1..6 keys while held. `interval` is the device's 16-bit speed parameter (0..6000). */
  | { type: 'emulate'; keys: CodeRef[]; interval: number }
  /** A slot the converter could not interpret, preserved verbatim as hex payloads (64 bytes each). */
  | { type: 'raw'; packets: string[] }

/** Shorthands accepted when reading a profile: a CodeRef means { type: 'key', code }, null means { type: 'none' }. */
export type ActionInput = Action | CodeRef | null

/** Map from physical key id (see device/layout.ts, e.g. "caps") to its action on one layer. */
export type LayerMap = Record<string, ActionInput>

export interface NamedAction {
  name: string
  action: Action
}

export interface Profile {
  $schema?: string
  format: 'plum-keymap'
  version: 1
  /** Keyboard model this profile targets. */
  device: '84EC-S'
  name?: string
  description?: string
  /**
   * What keys missing from `layers` do: "factory" = the factory default of that slot, "none" = nothing.
   * Default "none". Exported profiles always list all 84 keys on both layers.
   */
  inherit?: 'factory' | 'none'
  layers: Record<LayerId, LayerMap>
  /** Named combos / macros / emulates kept for reuse (KB84 "Predefined" libraries). Not sent to the device. */
  library?: { combos?: NamedAction[]; macros?: NamedAction[]; emulates?: NamedAction[] }
  /** Per-key RGB ("#rrggbb") from KB84 .pro files. The 84EC-S has no backlight; kept only for round-trips. */
  backlight?: Record<string, string>
}

/** A profile after validation: every action expanded to the full object form, every key present on both layers. */
export interface NormalizedProfile extends Omit<Profile, 'layers' | 'inherit'> {
  layers: Record<LayerId, Record<string, Action>>
}

export interface FormatIssue {
  /** JSON-pointer-like location, e.g. "/layers/fn/caps/steps/3". */
  path: string
  message: string
  severity: 'error' | 'warning'
}
