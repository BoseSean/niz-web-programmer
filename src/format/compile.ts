/**
 * Plum Keymap <-> wire slots. `actionToSlot` expects a normalized action (see normalize.ts); `slotToAction` never
 * fails and produces the canonical action form (known codes by id, unknown codes by number).
 */
import { codeByValue, resolveCodeRef } from '../device/codes'
import { KEYS } from '../device/layout'
import type { LayerId } from '../device/types'
import { LAYERS, DEVICE_MODEL } from '../device/types'
import { EMPTY_SLOT, type MacroPlayMode, type Slot, type SlotTable } from '../protocol/slots'
import type { Action, CodeRef, MacroPlay, MacroStep, NormalizedProfile } from './types'

export const FORMAT_ID = 'plum-keymap' as const
export const FORMAT_VERSION = 1 as const

/**
 * Largest macro data stream KB84 sends (bytes after the 11-byte header, summed over all packets): 1600 events with a
 * fixed interval (len 1600). Recorded timing stops at 400 events (len 4·400 − 3 = 1597), which this cap also enforces
 * because 401 events need 1601 bytes. KB84.exe 0x42ce20 / 0x42bd10, REA ev_82433f26… / ev_29d77afe….
 */
export const MACRO_MAX_DATA_BYTES = 1600

const PLAY_MODES: readonly MacroPlay[] = ['repeat', 'hold', 'toggle']

export const playToMode = (play: MacroPlay): MacroPlayMode => PLAY_MODES.indexOf(play) as MacroPlayMode
export const modeToPlay = (mode: MacroPlayMode): MacroPlay => PLAY_MODES[mode] ?? 'repeat'

/** Canonical CodeRef of a device code: its id when known, else the number. */
export function canonicalRef(value: number): CodeRef {
  return codeByValue(value)?.id ?? value
}

function wireOf(ref: CodeRef): number[] {
  const r = resolveCodeRef(ref)
  if (!r) throw new Error(`Unknown code ${JSON.stringify(ref)}`)
  return r.wire
}

function valueOf(ref: CodeRef): number {
  const r = resolveCodeRef(ref)
  if (!r) throw new Error(`Unknown code ${JSON.stringify(ref)}`)
  return r.value
}

/** The macro's toggle event stream and the per-gap delays (recorded timing only). */
export function macroEvents(steps: readonly MacroStep[], recorded: boolean): { events: number[]; delays: number[] } {
  const events: number[] = []
  const delays: number[] = []
  let pending = 0
  const push = (code: number) => {
    if (recorded && events.length > 0) delays.push(pending)
    pending = 0
    events.push(code)
  }
  for (const step of steps) {
    if ('wait' in step) pending += step.wait
    else if ('tap' in step) {
      const v = valueOf(step.tap)
      push(v)
      push(v)
    } else push(valueOf('down' in step ? step.down : step.up))
  }
  return { events, delays }
}

/** Length of the macro data stream on the wire. */
export const macroDataLength = (eventCount: number, recorded: boolean) =>
  recorded ? Math.max(0, 4 * eventCount - 3) : eventCount

export function actionToSlot(action: Action): Slot {
  switch (action.type) {
    case 'none':
      return EMPTY_SLOT
    case 'key':
      return { kind: 'codes', codes: wireOf(action.code) }
    case 'combo':
      return { kind: 'codes', codes: action.keys.flatMap(wireOf) }
    case 'emulate':
      return { kind: 'emulate', value: action.interval, codes: action.keys.flatMap(wireOf) }
    case 'macro': {
      const recorded = action.interval === undefined
      const { events, delays } = macroEvents(action.steps, recorded)
      return {
        kind: 'macro',
        playMode: playToMode(action.play),
        cycles: action.play === 'repeat' ? (action.repeat ?? 1) : 0,
        hasDelays: recorded,
        autoDelay: action.interval ?? 0,
        events,
        delays,
      }
    }
    case 'raw':
      return { kind: 'raw', packets: action.packets.map(hexToBytes) }
  }
}

export function slotToAction(slot: Slot): Action {
  switch (slot.kind) {
    case 'empty':
      return { type: 'none' }
    case 'codes': {
      const c = slot.codes
      if (c.length === 0) return { type: 'none' }
      if (c.length === 2 && c[0] === 130 && c[1] === 130) return { type: 'key', code: 'MouseDoubleClick' }
      if (c.length === 1) return { type: 'key', code: canonicalRef(c[0]) }
      return { type: 'combo', keys: c.map(canonicalRef) }
    }
    case 'emulate':
      if (slot.codes.length === 0) return { type: 'none' }
      return { type: 'emulate', keys: slot.codes.map(canonicalRef), interval: slot.value }
    case 'macro': {
      if (slot.events.length === 0) return { type: 'none' }
      const play = modeToPlay(slot.playMode)
      return {
        type: 'macro',
        play,
        ...(play === 'repeat' ? { repeat: slot.cycles } : {}),
        ...(slot.hasDelays ? {} : { interval: slot.autoDelay }),
        steps: eventsToSteps(slot.events, slot.hasDelays ? slot.delays : null),
      }
    }
    case 'raw':
      return { type: 'raw', packets: slot.packets.map(bytesToHex) }
  }
}

/** Toggle events -> down/up steps; a press directly followed by its release (0 ms when recorded) becomes a tap. */
function eventsToSteps(events: readonly number[], delays: readonly number[] | null): MacroStep[] {
  const steps: MacroStep[] = []
  const held = new Set<number>()
  for (let i = 0; i < events.length; i++) {
    const code = events[i]
    const ref = canonicalRef(code)
    if (!held.has(code) && events[i + 1] === code && (!delays || delays[i] === 0)) {
      steps.push({ tap: ref })
      i++
    } else if (held.has(code)) {
      held.delete(code)
      steps.push({ up: ref })
    } else {
      held.add(code)
      steps.push({ down: ref })
    }
    if (delays && i < events.length - 1) steps.push({ wait: delays[i] ?? 0 })
  }
  return steps
}

export function profileToTable(p: NormalizedProfile): SlotTable {
  const layer = (id: LayerId) => KEYS.map((k) => actionToSlot(p.layers[id][k.id] ?? { type: 'none' }))
  return { base: layer('base'), fn: layer('fn') }
}

export function tableToProfile(table: SlotTable, meta: { name?: string; description?: string } = {}): NormalizedProfile {
  const layers = {} as NormalizedProfile['layers']
  for (const id of LAYERS) {
    layers[id] = Object.fromEntries(KEYS.map((k, i) => [k.id, slotToAction(table[id][i] ?? EMPTY_SLOT)]))
  }
  return {
    format: FORMAT_ID,
    version: FORMAT_VERSION,
    device: DEVICE_MODEL,
    ...(meta.name !== undefined ? { name: meta.name } : {}),
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    layers,
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** Parses a hex string (whitespace ignored). Throws on malformed input; normalize.ts validates first. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '')
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(clean)) throw new Error(`Invalid hex string ${JSON.stringify(hex)}`)
  return Uint8Array.from(clean.match(/../g) ?? [], (b) => parseInt(b, 16))
}
