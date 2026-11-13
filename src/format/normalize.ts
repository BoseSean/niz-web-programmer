/**
 * Validation and normalization of Plum Keymap input (parsed JSON of unknown shape). Never throws: every problem is
 * reported as a FormatIssue with a JSON-pointer-like path. The profile is returned only when there is no error.
 */
import { resolveCodeRef } from '../device/codes'
import { FACTORY, KEYS, keyById } from '../device/layout'
import type { LayerId } from '../device/types'
import { DEVICE_MODEL, LAYERS, WIRE_LAYER } from '../device/types'
import {
  FORMAT_ID,
  FORMAT_VERSION,
  MACRO_MAX_DATA_BYTES,
  canonicalRef,
  hexToBytes,
  macroDataLength,
  slotToAction,
} from './compile'
import { rawFramingProblems } from '../protocol/codec'
import type { Action, CodeRef, FormatIssue, MacroPlay, MacroStep, NamedAction, NormalizedProfile } from './types'

const FN = 156
const DOUBLE_CLICK = 199
/** 0xC8 is the delay marker inside recorded macro data. */
const DELAY_MARKER = 200
const MAX_COMBO = 6
const MAX_EMULATE = 6
const MAX_EMULATE_INTERVAL = 6000
const MAX_MACRO_INTERVAL = 60000
const MAX_WAIT = 65535
const MAX_REPEAT = 255
const PACKET_BYTES = 64

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const show = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : String(v))

class Collector {
  readonly issues: FormatIssue[] = []
  error(path: string, message: string) {
    this.issues.push({ path, message, severity: 'error' })
  }
  warn(path: string, message: string) {
    this.issues.push({ path, message, severity: 'warning' })
  }
  get errorCount() {
    return this.issues.filter((i) => i.severity === 'error').length
  }
  get failed() {
    return this.errorCount > 0
  }
}

/** Context of the slot an action targets (raw packets carry the layer and key number). */
interface SlotContext {
  layer: LayerId
  keyNo: number
}

/** Resolves a CodeRef to its canonical form; returns null (after reporting) when it is not a usable code. */
function resolveRef(ref: unknown, path: string, out: Collector): { ref: CodeRef; value: number } | null {
  if (typeof ref !== 'string' && typeof ref !== 'number') {
    out.error(path, `Expected a code id or a number 1..255, got ${show(ref)}`)
    return null
  }
  const r = resolveCodeRef(ref)
  if (!r) {
    out.error(path, typeof ref === 'number' ? `Code ${ref} is not an integer 1..255` : `Unknown code id ${show(ref)}`)
    return null
  }
  if (!r.info) out.warn(path, `Code ${r.value} is not a known device code; it is sent as-is`)
  return { ref: canonicalRef(r.value), value: r.value }
}

function warnExtraProps(o: Obj, allowed: readonly string[], path: string, out: Collector) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) out.warn(`${path}/${k}`, `Unknown property "${k}" ignored`)
}

/** Code list of a combo or emulate. */
function codeList(v: unknown, path: string, out: Collector, what: string, min: number, max: number) {
  if (!Array.isArray(v)) {
    out.error(path, `${what} needs an array of codes`)
    return null
  }
  if (v.length < min || v.length > max) out.error(path, `${what} needs ${min}..${max} codes, got ${v.length}`)
  const refs: CodeRef[] = []
  const values: number[] = []
  v.forEach((item, i) => {
    const r = resolveRef(item, `${path}/${i}`, out)
    if (!r) return
    if (r.value === DOUBLE_CLICK) out.error(`${path}/${i}`, 'MouseDoubleClick is only allowed as a single key action')
    refs.push(r.ref)
    values.push(r.value)
  })
  return { refs, values }
}

function normalizeMacro(o: Obj, path: string, out: Collector): Action | null {
  warnExtraProps(o, ['type', 'play', 'repeat', 'interval', 'steps'], path, out)
  const play = o.play as MacroPlay
  if (play !== 'repeat' && play !== 'hold' && play !== 'toggle') {
    out.error(`${path}/play`, `play must be "repeat", "hold" or "toggle", got ${show(o.play)}`)
  }
  if (play === 'repeat') {
    if (!isInt(o.repeat, 1, MAX_REPEAT)) out.error(`${path}/repeat`, `play "repeat" needs repeat 1..${MAX_REPEAT}`)
  } else if (o.repeat !== undefined) {
    out.error(`${path}/repeat`, 'repeat is only allowed with play "repeat"')
  }
  const fixed = o.interval !== undefined
  if (fixed && !isInt(o.interval, 0, MAX_MACRO_INTERVAL)) {
    out.error(`${path}/interval`, `interval must be an integer 0..${MAX_MACRO_INTERVAL} (ms)`)
  }
  const input: unknown = o.steps
  if (!Array.isArray(input)) {
    out.error(`${path}/steps`, 'A macro needs a steps array')
    return null
  }

  const errorsBefore = out.errorCount
  const steps: MacroStep[] = []
  const held = new Set<number>()
  let events = 0
  let gap = 0 // accumulated wait since the last event (recorded timing)
  let overflowAt = '' // path of the wait that pushed `gap` past MAX_WAIT
  let trailing: string[] = [] // paths of the waits since the last event
  input.forEach((step, i) => {
    const sp = `${path}/steps/${i}`
    const keys = isObj(step) ? Object.keys(step) : []
    if (!isObj(step) || keys.length !== 1 || !['down', 'up', 'tap', 'wait'].includes(keys[0])) {
      out.error(sp, 'A step must be exactly one of {"down": code}, {"up": code}, {"tap": code}, {"wait": ms}')
      return
    }
    const kind = keys[0] as 'down' | 'up' | 'tap' | 'wait'
    if (kind === 'wait') {
      if (fixed) out.error(sp, 'wait steps are not allowed with a fixed interval (remove "interval" for recorded timing)')
      else if (!isInt(step.wait, 0, MAX_WAIT)) out.error(sp, `wait must be an integer 0..${MAX_WAIT} (ms)`)
      else {
        if (events === 0) out.warn(sp, 'A wait before the first event is ignored')
        else {
          gap += step.wait
          if (gap > MAX_WAIT && !overflowAt) overflowAt = sp
          trailing.push(sp)
        }
        steps.push({ wait: step.wait })
      }
      return
    }
    // The waits since the previous event form one delay; it is reported only now that an event follows.
    if (overflowAt) out.error(overflowAt, `Consecutive waits add up to ${gap} ms; at most ${MAX_WAIT} ms fit between two events`)
    gap = 0
    overflowAt = ''
    trailing = []
    const r = resolveRef(step[kind], sp, out)
    if (!r) return
    if (r.value === DOUBLE_CLICK) return out.error(sp, 'MouseDoubleClick is only allowed as a single key action')
    if (!fixed && r.value === DELAY_MARKER) {
      return out.error(sp, `Code ${DELAY_MARKER} cannot be used in a macro with recorded timing (it is the delay marker)`)
    }
    // The firmware toggles each code: its first occurrence presses it, the next releases it.
    if (kind !== 'up' && held.has(r.value)) return out.error(sp, `${show(r.ref)} is already held; this would release it`)
    if (kind === 'up' && !held.has(r.value)) return out.error(sp, `${show(r.ref)} is not held; this would press it`)
    if (kind === 'down') held.add(r.value)
    if (kind === 'up') held.delete(r.value)
    events += kind === 'tap' ? 2 : 1
    steps.push({ [kind]: r.ref } as MacroStep)
  })
  for (const sp of trailing) out.warn(sp, 'A wait after the last event is ignored')
  // Only when the steps themselves were fine, to avoid a second error for the same cause.
  if (events === 0 && out.errorCount === errorsBefore) {
    out.error(`${path}/steps`, 'A macro needs at least one down/up/tap step')
  }
  if (held.size > 0) {
    const names = [...held].map((v) => show(canonicalRef(v))).join(', ')
    out.warn(`${path}/steps`, `Still held when the macro ends: ${names}`)
  }
  const len = macroDataLength(events, !fixed)
  if (len > MACRO_MAX_DATA_BYTES) {
    out.error(`${path}/steps`, `Macro data is ${len} bytes; KB84 allows at most ${MACRO_MAX_DATA_BYTES}`)
  }
  return {
    type: 'macro',
    play,
    ...(play === 'repeat' ? { repeat: o.repeat as number } : {}),
    ...(fixed ? { interval: o.interval as number } : {}),
    steps,
  }
}

function normalizeRaw(o: Obj, path: string, out: Collector, ctx?: SlotContext): Action | null {
  warnExtraProps(o, ['type', 'packets'], path, out)
  if (!Array.isArray(o.packets) || o.packets.length === 0) {
    out.error(`${path}/packets`, 'raw needs a non-empty array of hex packets')
    return null
  }
  const packets: string[] = []
  o.packets.forEach((p, i) => {
    const pp = `${path}/packets/${i}`
    const hex = typeof p === 'string' ? p.replace(/\s+/g, '').toUpperCase() : ''
    if (!new RegExp(`^[0-9A-F]{${PACKET_BYTES * 2}}$`).test(hex)) {
      return out.error(pp, `Each packet must be ${PACKET_BYTES} bytes of hex (${PACKET_BYTES * 2} digits)`)
    }
    // Raw packets are sent verbatim, so a header for another slot would program that slot instead of this one.
    const expected = ctx ? [0x00, 0xf0, WIRE_LAYER[ctx.layer], ctx.keyNo] : [0x00, 0xf0]
    const head = expected.map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    if (hex.slice(0, head.length * 2) !== head.join('')) {
      const where = ctx ? ` (layer ${ctx.layer}, key ${ctx.keyNo})` : ''
      return out.error(pp, `Packet must start with ${head.join(' ')}${where}`)
    }
    packets.push(hex)
  })
  // Only when every packet is a well-formed slot packet: their count and macro headers must match what the first
  // packet announces, or the firmware may take the next slots' packets as this slot's continuation (PROTOCOL §9.5).
  if (packets.length === o.packets.length) {
    for (const problem of rawFramingProblems(packets.map(hexToBytes)))
      out.error(`${path}/packets`, problem.replace(/^raw: (.)/, (_, c: string) => c.toUpperCase()))
  }
  return { type: 'raw', packets }
}

/** Normalizes one ActionInput. Returns null when it is unusable (an error has been reported). */
function normalizeAction(input: unknown, path: string, out: Collector, ctx?: SlotContext): Action | null {
  if (input === null) return { type: 'none' }
  if (typeof input === 'string' || typeof input === 'number') {
    const r = resolveRef(input, path, out)
    return r && { type: 'key', code: r.ref }
  }
  if (!isObj(input)) {
    out.error(path, `Expected an action object, a code or null, got ${Array.isArray(input) ? 'an array' : show(input)}`)
    return null
  }
  switch (input.type) {
    case 'none':
      warnExtraProps(input, ['type'], path, out)
      return { type: 'none' }
    case 'key': {
      warnExtraProps(input, ['type', 'code'], path, out)
      const r = resolveRef(input.code, `${path}/code`, out)
      return r && { type: 'key', code: r.ref }
    }
    case 'combo': {
      warnExtraProps(input, ['type', 'keys'], path, out)
      const list = codeList(input.keys, `${path}/keys`, out, 'A combo', 2, MAX_COMBO)
      // KB84 records and sends a repeated key as is ([0, 2, A, A]; REA ev_82433f26…, ev_0a728786…), so a device slot
      // like that must stay writable: a warning, and the codes are kept byte for byte.
      list?.values.forEach((v, i) => {
        if (list.values.indexOf(v) !== i)
          out.warn(`${path}/keys/${i}`, `${show(list.refs[i])} appears twice in the combo; it is sent twice, as KB84 does`)
      })
      return list && { type: 'combo', keys: list.refs }
    }
    case 'emulate': {
      warnExtraProps(input, ['type', 'keys', 'interval'], path, out)
      const list = codeList(input.keys, `${path}/keys`, out, 'An emulate', 1, MAX_EMULATE)
      if (!isInt(input.interval, 0, MAX_EMULATE_INTERVAL)) {
        out.error(`${path}/interval`, `interval must be an integer 0..${MAX_EMULATE_INTERVAL}`)
      }
      return list && { type: 'emulate', keys: list.refs, interval: input.interval as number }
    }
    case 'macro':
      return normalizeMacro(input, path, out)
    case 'raw':
      return normalizeRaw(input, path, out, ctx)
    default:
      out.error(`${path}/type`, `Unknown action type ${show(input.type)}`)
      return null
  }
}

/** Action type each library group holds (KB84 PredefinedCombo / PredefinedMacro / PredefinedEmu). */
const LIBRARY_KIND = { combos: 'combo', macros: 'macro', emulates: 'emulate' } as const

const hasFn = (a: Action | undefined) => a?.type === 'key' && resolveCodeRef(a.code)?.value === FN

function normalizeLibrary(v: unknown, out: Collector): NonNullable<NormalizedProfile['library']> | undefined {
  if (!isObj(v)) {
    out.error('/library', 'library must be an object')
    return undefined
  }
  warnExtraProps(v, ['combos', 'macros', 'emulates'], '/library', out)
  const lib: NonNullable<NormalizedProfile['library']> = {}
  for (const group of ['combos', 'macros', 'emulates'] as const) {
    const list = v[group]
    if (list === undefined) continue
    const gp = `/library/${group}`
    if (!Array.isArray(list)) {
      out.error(gp, `${group} must be an array`)
      continue
    }
    lib[group] = list.flatMap((item, i): NamedAction[] => {
      const ip = `${gp}/${i}`
      if (!isObj(item) || typeof item.name !== 'string') {
        out.error(ip, 'Expected { "name": string, "action": action }')
        return []
      }
      warnExtraProps(item, ['name', 'action'], ip, out)
      const action = normalizeAction(item.action, `${ip}/action`, out)
      if (!action) return []
      if (action.type !== LIBRARY_KIND[group]) {
        out.error(`${ip}/action`, `The ${group} library holds only ${LIBRARY_KIND[group]} actions, got ${action.type}`)
        return []
      }
      return [{ name: item.name, action }]
    })
  }
  return lib
}

export function normalizeProfile(input: unknown): { profile: NormalizedProfile | null; issues: FormatIssue[] } {
  const out = new Collector()
  if (!isObj(input)) {
    out.error('', 'A profile must be a JSON object')
    return { profile: null, issues: out.issues }
  }
  warnExtraProps(
    input,
    ['$schema', 'format', 'version', 'device', 'name', 'description', 'inherit', 'layers', 'library', 'backlight'],
    '',
    out,
  )
  if (input.format !== FORMAT_ID) out.error('/format', `format must be "${FORMAT_ID}"`)
  if (input.version !== FORMAT_VERSION) out.error('/version', `Unsupported version ${show(input.version)} (expected 1)`)
  if (input.device !== DEVICE_MODEL) out.error('/device', `device must be "${DEVICE_MODEL}", got ${show(input.device)}`)
  for (const k of ['name', 'description'] as const) {
    if (input[k] !== undefined && typeof input[k] !== 'string') out.error(`/${k}`, `${k} must be a string`)
  }
  const inherit = input.inherit ?? 'none'
  if (inherit !== 'factory' && inherit !== 'none') out.error('/inherit', 'inherit must be "factory" or "none"')

  const layers = {} as NormalizedProfile['layers']
  if (!isObj(input.layers)) out.error('/layers', 'layers must be an object with "base" and "fn"')
  else {
    for (const k of Object.keys(input.layers)) {
      if (!(LAYERS as readonly string[]).includes(k)) out.error(`/layers/${k}`, `Unknown layer "${k}" (use "base" or "fn")`)
    }
    for (const layer of LAYERS) {
      const lp = `/layers/${layer}`
      const map = input.layers[layer]
      if (!isObj(map)) {
        out.error(lp, `${layer} must be an object mapping key ids to actions`)
        continue
      }
      for (const k of Object.keys(map)) if (!keyById(k)) out.error(`${lp}/${k}`, `Unknown key id "${k}"`)
      const actions: Record<string, Action> = {}
      KEYS.forEach((key, i) => {
        if (Object.hasOwn(map, key.id)) {
          const a = normalizeAction(map[key.id], `${lp}/${key.id}`, out, { layer, keyNo: key.no })
          if (a) actions[key.id] = a
        } else {
          actions[key.id] = inherit === 'factory' ? slotToAction(FACTORY[layer][i]) : { type: 'none' }
        }
      })
      layers[layer] = actions
    }
  }

  if (layers.base && layers.fn) {
    if (!KEYS.some((k) => hasFn(layers.base[k.id]))) {
      out.warn('/layers/base', 'No key has Fn on the base layer; the Fn layer cannot be reached')
    }
    for (const k of KEYS) {
      const [b, f] = [hasFn(layers.base[k.id]), hasFn(layers.fn[k.id])]
      if (b !== f) {
        const [has, lacks] = b ? ['base', 'fn'] : ['fn', 'base']
        out.warn(`/layers/${has}/${k.id}`, `Fn is set on the ${has} layer of "${k.id}" but not on its ${lacks} layer; set it on both`)
      }
    }
  }

  const library = input.library === undefined ? undefined : normalizeLibrary(input.library, out)
  let backlight: Record<string, string> | undefined
  if (input.backlight !== undefined) {
    if (!isObj(input.backlight)) out.error('/backlight', 'backlight must be an object of "#rrggbb" colors')
    else {
      backlight = {}
      for (const [k, v] of Object.entries(input.backlight)) {
        if (!keyById(k)) out.error(`/backlight/${k}`, `Unknown key id "${k}"`)
        else if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) backlight[k] = v.toLowerCase()
        else out.error(`/backlight/${k}`, 'Expected a "#rrggbb" color')
      }
    }
  }

  if (out.failed) return { profile: null, issues: out.issues }
  const profile: NormalizedProfile = {
    format: FORMAT_ID,
    version: FORMAT_VERSION,
    device: DEVICE_MODEL,
    ...(typeof input.name === 'string' ? { name: input.name } : {}),
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
    layers,
    ...(library ? { library } : {}),
    ...(backlight ? { backlight } : {}),
  }
  return { profile, issues: out.issues }
}

/** Validates and normalizes a single ActionInput (e.g. from an editor); `path` prefixes issue paths. */
export function normalizeActionInput(input: unknown, path = ''): { action: Action | null; issues: FormatIssue[] } {
  const out = new Collector()
  const action = normalizeAction(input, path, out)
  return { action: out.failed ? null : action, issues: out.issues }
}

/** JSON text (a leading BOM is ignored) -> normalized profile; a syntax error becomes an issue at path "". */
export function parseProfileJson(text: string): { profile: NormalizedProfile | null; issues: FormatIssue[] } {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch (e) {
    return { profile: null, issues: [{ path: '', message: `Invalid JSON: ${(e as Error).message}`, severity: 'error' }] }
  }
  return normalizeProfile(data)
}
