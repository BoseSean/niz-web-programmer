/**
 * KB84 `.pro` profile import/export (spec section g, docs/re/profile.verified.en.md).
 *
 * The importer is strict where KB84 would load garbage (missing/out-of-order sections, KEY without ComboKey,
 * out-of-range IDs, labels KB84 would turn into code 0). The exporter writes KB84's exact byte format; a profile
 * imported from a file KB84 itself saved re-exports byte-identically as long as the file holds no stale data
 * (HWCode ≠ ID on Mode 0/2/3/4 keys, lists left on single-code keys) and its list UI state follows the append rule.
 */
import { CODES, codeByValue, resolveCodeRef } from '../device/codes'
import { KEYS } from '../device/layout'
import { DEVICE_MODEL, KEY_COUNT, LAYERS } from '../device/types'
import type { LayerId } from '../device/types'
import type { Action, CodeRef, FormatIssue, MacroPlay, MacroStep, NamedAction, NormalizedProfile } from '../format/types'
import { XmlError, parseXml } from './xml'
import type { XmlElement } from './xml'

const SECTIONS = ['PredefinedCombo', 'PredefinedMacro', 'PredefinedEmu', 'BackgroundLightSettings', 'CurrentSettings']
const PLAY_MODES: readonly MacroPlay[] = ['repeat', 'hold', 'toggle']
/** List SizeOfView KB84 uses for combo / macro / emulate lists and libraries. */
const VIEW_SIZE = { combo: 6, macro: 9, emulate: 9 } as const
type ListKind = keyof typeof VIEW_SIZE
/** Value limits of the Plum format (format/types.ts), which match KB84's own UI clamps. */
const MAX_LIST_KEYS = 6
const MAX_REPEAT = 255
const MAX_MACRO_INTERVAL = 60000
const MAX_EMULATE_INTERVAL = 6000
const MAX_WAIT = 65535
const DOUBLE_CLICK = 199

const LIBRARIES = [
  { section: 'PredefinedCombo', kind: 'combo', key: 'combos' },
  { section: 'PredefinedMacro', kind: 'macro', key: 'macros' },
  { section: 'PredefinedEmu', kind: 'emulate', key: 'emulates' },
] as const

// --- labels ---------------------------------------------------------------------------------------------------

/**
 * KB84's label parser (0x441db0) accepts `name`, `name UP` and `name Down` for every named entry of its VK table and
 * returns the first match. Over the entries with a non-zero code this is exactly the codes' proLabel (checked
 * against docs/re/labels.json in the tests); every other label yields code 0, which we report as unknown.
 */
const CODE_BY_LABEL = new Map(CODES.flatMap((c) => (c.proLabel === null ? [] : [[c.proLabel, c.value] as const])))

export type ParsedLabel = { wait: number } | { code: number; dir: 'bare' | 'down' | 'up' }

export function parseProLabel(label: string): ParsedLabel | null {
  // KB84: any label containing "ms>" is a delay, value = wtoi(label.Mid(1, len - 5)).
  if (label.includes('ms>')) return { wait: wcstol(label.slice(1, label.length - 4)) }
  const exact = CODE_BY_LABEL.get(label)
  if (exact !== undefined) return { code: exact, dir: 'bare' }
  for (const [suffix, dir] of [[' Down', 'down'], [' UP', 'up']] as const) {
    if (!label.endsWith(suffix)) continue
    const code = CODE_BY_LABEL.get(label.slice(0, -suffix.length))
    if (code !== undefined) return { code, dir }
  }
  return null
}

/** C `wcstol(s, NULL, 10)`: optional whitespace and sign, then digits; anything else gives 0; saturates to int32. */
function wcstol(s: string | undefined): number {
  const m = s === undefined ? null : /^\s*([+-]?\d+)/.exec(s)
  if (!m) return 0
  return Math.max(-0x80000000, Math.min(0x7fffffff, Number(m[1])))
}

const codeRefOf = (value: number): CodeRef => codeByValue(value)?.id ?? value

// --- import ---------------------------------------------------------------------------------------------------

interface ProList {
  cycles: number
  auto: boolean
  delay: number
  playMode: number
  items: { label: string; child: ProList }[]
}

const defaultList = (): ProList => ({ cycles: 1, auto: false, delay: 30, playMode: 0, items: [] })

export interface ProParseResult {
  /** null when any issue has severity "error". */
  profile: NormalizedProfile | null
  issues: FormatIssue[]
}

/**
 * Parses a KB84 .pro file. A BOM and LF line endings are accepted. Every error-severity issue makes `profile` null;
 * warnings (e.g. a Down/UP suffix that disagrees with the device's toggle semantics) leave it usable.
 */
export function parseProFile(text: string): ProParseResult {
  const issues: FormatIssue[] = []
  const error = (path: string, message: string) => void issues.push({ path, message, severity: 'error' })
  const warn = (path: string, message: string) => void issues.push({ path, message, severity: 'warning' })
  const fail = () => ({ profile: null, issues })

  let root: XmlElement
  try {
    root = parseXml(text.replace(/^﻿/, ''))
  } catch (e) {
    if (!(e instanceof XmlError)) throw e
    error('', e.message)
    return fail()
  }
  if (root.name !== 'KB84') {
    error('', `root element is <${root.name}>, expected <KB84>`)
    return fail()
  }

  // The five sections, in order (KB84 silently loses a missing or out-of-order section).
  const sections = new Map<string, XmlElement>()
  let from = 0
  for (const name of SECTIONS) {
    const idx = root.children.findIndex((c, i) => i >= from && c.name === name)
    if (idx >= 0) {
      sections.set(name, root.children[idx])
      from = idx + 1
    } else if (root.children.some((c) => c.name === name)) {
      error(`/KB84/${name}`, `section <${name}> is out of order (expected ${SECTIONS.join(', ')})`)
    } else {
      error(`/KB84/${name}`, `missing section <${name}>`)
    }
  }
  if (issues.length) return fail()

  const readList = (el: XmlElement | undefined, path: string): ProList => {
    if (!el) return defaultList()
    const attr = (name: string) => wcstol(el.attrs.get(name))
    const list: ProList = {
      cycles: attr('Cycles'),
      auto: attr('IsAutoInterval') !== 0,
      delay: attr('Delay'),
      playMode: attr('PlayMode'),
      items: [],
    }
    for (const x of el.children) {
      if (x.name !== 'x') continue
      const id = wcstol(x.attrs.get('ID'))
      if (id < 0 || id >= 0x10000) {
        error(`${path}/x[${id}]`, `line ${x.line}: item ID ${id} is out of range`)
        continue
      }
      while (list.items.length <= id) list.items.push({ label: '', child: defaultList() })
      list.items[id] = { label: x.attrs.get('t1') ?? '', child: readList(childNamed(x, 'List'), `${path}/x[${id}]`) }
    }
    return list
  }

  /** A list-item code; MouseDoubleClick is rejected because KB84 would send byte 0xC7 instead of [130, 130]. */
  const itemCode = (p: { code: number }, label: string, at: string): number | null => {
    if (p.code !== DOUBLE_CLICK) return p.code
    error(at, `"${label}" inside a list: KB84 would send byte 0xC7, not a double click`)
    return null
  }

  /** Labels → codes (combo / emulate); null when an error was reported. */
  const listCodes = (list: ProList, path: string): number[] | null => {
    let ok = true
    const codes = list.items.map(({ label }, i) => {
      const p = parseProLabel(label)
      if (!p || 'wait' in p) error(`${path}/keys/${i}`, p ? `delay item "${label}" is not allowed here` : unknownLabel(label))
      const code = p && 'code' in p ? itemCode(p, label, `${path}/keys/${i}`) : null
      if (code === null) ok = false
      return code ?? 0
    })
    return ok ? codes : null
  }

  const inRange = (value: number, min: number, max: number, path: string, what: string): boolean => {
    if (value >= min && value <= max) return true
    error(path, `${what} ${value} is outside ${min}..${max}`)
    return false
  }

  const listToMacro = (list: ProList, path: string): Action | null => {
    const play = PLAY_MODES[list.playMode]
    if (!play) {
      error(path, `PlayMode ${list.playMode} is not 0, 1 or 2`)
      return null
    }
    let ok = play !== 'repeat' || inRange(list.cycles, 1, MAX_REPEAT, path, 'Cycles')
    if (list.auto) ok = inRange(list.delay, 0, MAX_MACRO_INTERVAL, path, 'Delay') && ok
    const steps: MacroStep[] = []
    const pressed = new Set<number>()
    list.items.forEach(({ label }, i) => {
      const at = `${path}/steps/${i}`
      const p = parseProLabel(label)
      if (!p) {
        error(at, unknownLabel(label))
        ok = false
      } else if ('wait' in p) {
        if (list.auto) {
          error(at, `delay item "${label}" in a fixed-interval macro`)
          ok = false
        } else if (inRange(p.wait, 0, MAX_WAIT, at, 'delay')) steps.push({ wait: p.wait })
        else ok = false
      } else {
        const code = itemCode(p, label, at)
        if (code === null) {
          ok = false
          return
        }
        // The device toggles each code (KB84 drops the Down/UP suffix): the first occurrence presses it, the next
        // releases it. The step follows the device; a contradicting suffix only gets a warning.
        const press = !pressed.has(code)
        if (press) pressed.add(code)
        else pressed.delete(code)
        if (p.dir !== 'bare' && (p.dir === 'down') !== press) {
          warn(at, `"${label}": the keyboard toggles keys, so this ${press ? 'presses' : 'releases'} it`)
        }
        steps.push(press ? { down: codeRefOf(code) } : { up: codeRefOf(code) })
      }
    })
    if (ok && !steps.some((s) => !('wait' in s))) {
      error(path, 'macro has no key events')
      ok = false
    }
    if (!list.auto && !alternates(list.items.map((it) => parseProLabel(it.label)))) {
      warn(path, 'KB84 expects key and <N ms> items to alternate; it would send this macro differently')
    }
    if (!ok) return null
    const action: Extract<Action, { type: 'macro' }> = { type: 'macro', play, steps }
    if (play === 'repeat') action.repeat = list.cycles
    if (list.auto) action.interval = list.delay
    return action
  }

  /**
   * null when an error was reported. A one-key combo becomes a key action. A repeated key is kept (KB84 records
   * "A, A" when a key is pressed twice and sends [0, 2, A, A]; REA ev_82433f26…, ev_0a728786…) with a warning.
   */
  const listToAction = (kind: ListKind, list: ProList, path: string): Action | null => {
    if (kind === 'macro') return listToMacro(list, path)
    const codes = listCodes(list, path)
    if (!codes) return null
    if (kind === 'emulate') {
      const ok = inRange(codes.length, 1, MAX_LIST_KEYS, `${path}/keys`, 'key count')
      return inRange(list.delay, 0, MAX_EMULATE_INTERVAL, path, 'Delay') && ok
        ? { type: 'emulate', keys: codes.map(codeRefOf), interval: list.delay }
        : null
    }
    if (new Set(codes).size < codes.length) warn(`${path}/keys`, 'a key appears twice in the combo; it is kept, as KB84 sends it')
    if (!inRange(codes.length, 1, MAX_LIST_KEYS, `${path}/keys`, 'key count')) return null
    if (codes.length === 1) return { type: 'key', code: codeRefOf(codes[0]) } // what KB84 sends: [0, 1, code]
    return { type: 'combo', keys: codes.map(codeRefOf) }
  }

  // Libraries. Entries KB84's UI leaves empty, and one-key combos, cannot be represented and are skipped.
  const library: Required<NonNullable<NormalizedProfile['library']>> = { combos: [], macros: [], emulates: [] }
  for (const lib of LIBRARIES) {
    const path = `/library/${lib.key}`
    const top = readList(childNamed(sections.get(lib.section)!, 'List'), path)
    top.items.forEach((entry, i) => {
      if (entry.child.items.length === 0) return warn(`${path}/${i}`, `library entry "${entry.label}" is empty; skipped`)
      const action = listToAction(lib.kind, entry.child, `${path}/${i}`)
      if (action?.type === lib.kind) library[lib.key].push({ name: entry.label, action } satisfies NamedAction)
      else if (action) warn(`${path}/${i}`, `library combo "${entry.label}" has a single key; skipped`)
    })
  }

  // Lights.
  const backlight: Record<string, string> = {}
  for (const area of sections.get('BackgroundLightSettings')!.children) {
    if (area.name !== 'AREA') continue
    const id = wcstol(area.attrs.get('ID'))
    // KB84 reads AREA ID 0 into an unused entry and never writes it back (REA ev_672f6700…, ev_81fc1c18…).
    if (id === 0) {
      warn(`/KB84/BackgroundLightSettings`, `line ${area.line}: AREA ID 0 is not a key; ignored`)
      continue
    }
    const key = KEYS[id - 1]
    if (!key) {
      error(`/KB84/BackgroundLightSettings`, `line ${area.line}: AREA ID ${id} is outside 1..${KEY_COUNT}`)
      continue
    }
    const rgb = ['Red', 'Green', 'Blue'].map((c) => {
      const v = wcstol(area.attrs.get(c))
      if (v < 0 || v > 255) warn(`/backlight/${key.id}`, `${c}=${v} clamped to 0..255`)
      return Math.max(0, Math.min(255, v))
    })
    if (rgb.some((v) => v)) backlight[key.id] = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
    else delete backlight[key.id]
  }

  // Keys: placed by (ID, Level); the last duplicate wins.
  const keyEls = new Map<number, XmlElement>()
  for (const el of sections.get('CurrentSettings')!.children) {
    if (el.name !== 'KEY') continue
    const id = wcstol(el.attrs.get('ID'))
    const level = wcstol(el.attrs.get('Level'))
    const where = `/KB84/CurrentSettings/KEY[ID=${id},Level=${level}]`
    if (id < 1 || id > KEY_COUNT || (level !== 0 && level !== 1)) {
      error(where, `line ${el.line}: KEY ID must be 1..${KEY_COUNT} and Level 0 or 1`)
    } else if (!childNamed(el, 'ComboKey')) {
      error(where, `line ${el.line}: KEY has no <ComboKey> (KB84 would drop every later key)`)
    } else {
      if (keyEls.has(id * 2 + level)) warn(where, `line ${el.line}: duplicate KEY, the last one wins`)
      keyEls.set(id * 2 + level, el)
    }
  }

  const layers = { base: {}, fn: {} } as Record<LayerId, Record<string, Action>>
  for (const key of KEYS) {
    LAYERS.forEach((layer, level) => {
      const path = `/layers/${layer}/${key.id}`
      const el = keyEls.get(key.no * 2 + level)
      if (!el) warn(path, `KEY ID=${key.no} Level=${level} is missing; treated as empty`)
      const mode = el ? wcstol(el.attrs.get('Mode')) : 0
      const hw = el ? wcstol(el.attrs.get('HWCode')) : key.no
      let action: Action | null = { type: 'none' }
      if (mode === 2 || mode === 3 || mode === 4) {
        const list = readList(childNamed(childNamed(el!, 'ComboKey')!, 'List'), path)
        if (list.items.length === 0) warn(path, `Mode ${mode} with an empty list; KB84 sends nothing, treated as empty`)
        else action = listToAction(mode === 2 ? 'combo' : mode === 3 ? 'macro' : 'emulate', list, path)
      } else if (mode > 0) {
        // Any other positive Mode is a single code (KB84 sends [0, 1, HWCode]).
        if ((hw >= 1 && hw <= 255) || hw === 199) action = { type: 'key', code: codeRefOf(hw) }
        else error(path, `HWCode ${hw} is not a device code`)
      }
      if (action) layers[layer][key.id] = action
    })
  }

  if (issues.some((i) => i.severity === 'error')) return fail()
  const profile: NormalizedProfile = { format: 'plum-keymap', version: 1, device: DEVICE_MODEL, layers }
  if (library.combos.length || library.macros.length || library.emulates.length) profile.library = library
  if (Object.keys(backlight).length) profile.backlight = backlight
  return { profile, issues }
}

function childNamed(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => c.name === name)
}

function unknownLabel(label: string): string {
  return label === '' ? 'empty item (gap in the x IDs)' : `unknown key label "${label}" (KB84 would send code 0)`
}

/** KB84's recorded-macro layout: key, <N ms>, key, …, key. */
function alternates(items: (ParsedLabel | null)[]): boolean {
  return items.length === 0 || (items.every((p, i) => p === null || ('wait' in p) === (i % 2 === 1)) && items.length % 2 === 1)
}

// --- export ---------------------------------------------------------------------------------------------------

interface OutList {
  sov: number
  cycles: number
  auto: boolean
  delay: number
  playMode: number
  items: { label: string; child?: OutList }[]
}

const outList = (sov: number, items: OutList['items'] = [], extra: Partial<OutList> = {}): OutList => ({
  sov,
  cycles: 1,
  auto: false,
  delay: 30,
  playMode: 0,
  items,
  ...extra,
})

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)

function int(v: number, what: string): number {
  if (!Number.isInteger(v)) throw new Error(`${what}: ${v} is not an integer`)
  return v
}

function writeList(out: string[], list: OutList): void {
  const n = list.items.length
  // KB84 append rule (0x43a810) applied item by item from an empty list.
  const vsa = Math.max(0, n - list.sov)
  const cp = n === 0 ? 0 : n - vsa - 1
  const head =
    `<List SizeOfView="${list.sov}" ViewStartAt="${vsa}" CursorPos="${cp}" Cycles="${int(list.cycles, 'Cycles')}"` +
    ` IsAutoInterval="${list.auto ? 1 : 0}" Delay="${int(list.delay, 'Delay')}" PlayMode="${list.playMode}"`
  if (n === 0) {
    out.push(head + '/>')
    return
  }
  out.push(head + '>')
  list.items.forEach((item, i) => {
    out.push(`<x ID="${i}" t1="${esc(item.label)}">`)
    writeList(out, item.child ?? outList(list.sov))
    out.push('</x>')
  })
  out.push('</List>')
}

function proLabelOf(ref: CodeRef, path: string): string {
  const info = resolveCodeRef(ref)?.info
  // KB84 would parse "Left Double Click" to 199 and send it as one byte 0xC7, not as a double click.
  if (!info?.proLabel || info.value === DOUBLE_CLICK) {
    throw new Error(`${path}: code ${JSON.stringify(ref)} has no KB84 label, so KB84 cannot store it in a list`)
  }
  return info.proLabel
}

/** The ComboKey/List content KB84 builds for a combo, macro or emulate action. */
function actionList(action: Action, path: string): OutList {
  switch (action.type) {
    case 'combo':
      return outList(VIEW_SIZE.combo, action.keys.map((k, i) => ({ label: proLabelOf(k, `${path}/keys/${i}`) })))
    case 'emulate':
      return outList(
        VIEW_SIZE.emulate,
        action.keys.map((k, i) => ({ label: proLabelOf(k, `${path}/keys/${i}`) })),
        { delay: action.interval },
      )
    case 'macro': {
      const auto = action.interval !== undefined
      // Recorded macros must read key, <N ms>, key, …, key (KB84 sends labels[2i] as codes and labels[2i+1] as
      // delays), so adjacent keys get <0 ms> between them and adjacent waits are summed. Waits before the first or
      // after the last key event have no place on the device and are dropped, as the wire encoder does.
      const labels: string[] = []
      let wait = 0
      const pushKey = (label: string) => {
        if (!auto && labels.length) labels.push(`<${wait} ms>`)
        labels.push(label)
        wait = 0
      }
      for (const [i, step] of action.steps.entries()) {
        const at = `${path}/steps/${i}`
        if ('wait' in step) {
          if (auto) throw new Error(`${at}: wait steps are not allowed in a macro with a fixed interval`)
          wait += int(step.wait, at)
        } else if ('down' in step) pushKey(`${proLabelOf(step.down, at)} Down`)
        else if ('up' in step) pushKey(`${proLabelOf(step.up, at)} UP`)
        else {
          const name = proLabelOf(step.tap, at)
          pushKey(`${name} Down`)
          pushKey(`${name} UP`)
        }
      }
      return outList(
        VIEW_SIZE.macro,
        labels.map((label) => ({ label })),
        {
          cycles: action.play === 'repeat' ? (action.repeat ?? 1) : 1,
          auto,
          delay: action.interval ?? 30,
          playMode: PLAY_MODES.indexOf(action.play),
        },
      )
    }
    default:
      throw new Error(`${path}: a ${action.type} action cannot be stored in a KB84 list`)
  }
}

/** KEY Mode / HWCode / list for one slot, the way KB84's dialog OK handler builds them. */
function encodeKey(action: Action, keyNo: number, path: string): { mode: number; hw: number; list: OutList } {
  switch (action.type) {
    case 'none':
      return { mode: 0, hw: keyNo, list: outList(0) }
    case 'key': {
      const r = resolveCodeRef(action.code)
      if (!r) throw new Error(`${path}: unknown code ${JSON.stringify(action.code)}`)
      return { mode: r.info?.kb84Mode ?? 1, hw: r.value, list: outList(0) }
    }
    case 'combo':
      return { mode: 2, hw: keyNo, list: actionList(action, path) }
    case 'macro':
      return { mode: 3, hw: keyNo, list: actionList(action, path) }
    case 'emulate':
      return { mode: 4, hw: keyNo, list: actionList(action, path) }
    case 'raw':
      throw new Error(`${path}: a raw device slot cannot be represented in a KB84 .pro file`)
  }
}

function parseColor(value: string | undefined, path: string): number[] {
  if (value === undefined) return [0, 0, 0]
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(value)
  if (!m) throw new Error(`${path}: "${value}" is not a #rrggbb colour`)
  return m.slice(1).map((h) => parseInt(h, 16))
}

/**
 * Serialises a profile in KB84's exact .pro byte format (UTF-8 without BOM once encoded, CRLF after every line).
 * Throws an Error naming the offending path for content KB84 cannot represent (raw slots, codes without a KB84 label
 * inside lists (including MouseDoubleClick), library entries that are not combo/macro/emulate, non-integer numbers).
 * Library entries are written to the section of their action type. Waits before the first or after the last macro
 * event are dropped (the device has no place for them).
 */
export function toProFile(p: NormalizedProfile): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<KB84>']

  // Library entries go to the section of their action type (the format does not tie a type to a group).
  const libEntries = LIBRARIES.flatMap((lib) =>
    (p.library?.[lib.key] ?? []).map((entry, i) => ({ ...entry, path: `/library/${lib.key}/${i}` })),
  )
  for (const { action, path } of libEntries) {
    if (!LIBRARIES.some((lib) => lib.kind === action.type)) {
      throw new Error(`${path}: a ${action.type} action cannot be stored in a KB84 library`)
    }
  }
  for (const lib of LIBRARIES) {
    const sov = VIEW_SIZE[lib.kind]
    const entries = libEntries
      .filter((e) => e.action.type === lib.kind)
      .map(({ name, action, path }) => ({ label: name, child: actionList(action, path) }))
    out.push(`<${lib.section}>`)
    writeList(out, outList(sov, entries))
    out.push(`</${lib.section}>`)
  }

  for (const id of Object.keys(p.backlight ?? {})) {
    if (!KEYS.some((k) => k.id === id)) throw new Error(`/backlight/${id}: unknown key id`)
  }
  out.push('<BackgroundLightSettings>')
  for (const key of KEYS) {
    const [r, g, b] = parseColor(p.backlight?.[key.id], `/backlight/${key.id}`)
    out.push(`<AREA ID="${key.no}" Red="${r}" Green="${g}" Blue="${b}"/>`)
  }
  out.push('</BackgroundLightSettings>')

  out.push('<CurrentSettings>')
  for (const key of [...KEYS].sort((a, b) => a.no - b.no)) {
    LAYERS.forEach((layer, level) => {
      const path = `/layers/${layer}/${key.id}`
      const { mode, hw, list } = encodeKey(p.layers[layer][key.id] ?? { type: 'none' }, key.no, path)
      out.push(`<KEY ID="${key.no}" Level="${level}" Mode="${mode}" HWCode="${hw}">`, '<ComboKey>')
      writeList(out, list)
      out.push('</ComboKey>', '</KEY>')
    })
  }
  out.push('</CurrentSettings>', '</KB84>')
  return out.join('\r\n') + '\r\n'
}
