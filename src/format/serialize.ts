/**
 * Human-friendly Plum Keymap JSON: keys in layout order, single-code actions as shorthand strings, none as null,
 * other actions as compact one-line objects (macro steps and raw packets one per line).
 */
import { FACTORY, KEYS } from '../device/layout'
import { LAYERS } from '../device/types'
import type { Slot } from '../protocol/slots'
import { actionToSlot, bytesToHex } from './compile'
import type { Action, NamedAction, NormalizedProfile } from './types'

/** Default `$schema`, relative to a profile kept in a top-level folder of the repository. */
export const DEFAULT_SCHEMA_URL = '../format/plum-keymap.schema.json'

export interface SerializeOptions {
  /** 'full' (default) lists all 84 keys on both layers; 'diff-factory' writes inherit "factory" and only changed keys. */
  style?: 'full' | 'diff-factory'
  /** Value of "$schema"; null omits it. */
  schemaUrl?: string | null
}

const IND = '  '

/** Compact single-line JSON: `{ "a": 1, "b": [1, 2] }`. */
function inline(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`
  if (typeof v === 'object' && v !== null) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined)
    return entries.length ? `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}'
  }
  return JSON.stringify(v)
}

/** One action as JSON text; `ind` is the indentation of the line the value starts on. */
export function formatAction(a: Action, ind = ''): string {
  switch (a.type) {
    case 'none':
      return 'null'
    case 'key':
      return JSON.stringify(a.code)
    case 'macro': {
      const { steps, ...head } = a
      const body = steps.map((s) => `${ind}${IND}${IND}${inline(s)}`).join(',\n')
      return `{ ${inline(head).slice(2, -2)},\n${ind}${IND}"steps": [\n${body}\n${ind}${IND}] }`
    }
    case 'raw': {
      const body = a.packets.map((p) => `${ind}${IND}${IND}${JSON.stringify(p)}`).join(',\n')
      return `{ "type": "raw", "packets": [\n${body}\n${ind}${IND}] }`
    }
    default:
      return inline(a)
  }
}

function slotKey(s: Slot): string {
  return s.kind === 'raw' ? `raw:${s.packets.map(bytesToHex).join(',')}` : JSON.stringify(s)
}

function formatNamed(list: NamedAction[], ind: string): string {
  const items = list.map((n) => `${ind}${IND}{ "name": ${JSON.stringify(n.name)}, "action": ${formatAction(n.action, `${ind}${IND}`)} }`)
  return items.length ? `[\n${items.join(',\n')}\n${ind}]` : '[]'
}

export function serializeProfile(p: NormalizedProfile, opts: SerializeOptions = {}): string {
  const diff = opts.style === 'diff-factory'
  const schemaUrl = opts.schemaUrl === undefined ? DEFAULT_SCHEMA_URL : opts.schemaUrl
  const lines: string[] = []
  const field = (k: string, text: string) => lines.push(`${IND}${JSON.stringify(k)}: ${text}`)

  if (schemaUrl !== null) field('$schema', JSON.stringify(schemaUrl))
  field('format', JSON.stringify(p.format))
  field('version', JSON.stringify(p.version))
  field('device', JSON.stringify(p.device))
  if (p.name !== undefined) field('name', JSON.stringify(p.name))
  if (p.description !== undefined) field('description', JSON.stringify(p.description))
  if (diff) field('inherit', '"factory"')

  const layerTexts = LAYERS.map((layer) => {
    const ind = IND.repeat(3)
    const entries = KEYS.flatMap((k, i) => {
      const a = p.layers[layer][k.id] ?? { type: 'none' }
      if (diff && slotKey(actionToSlot(a)) === slotKey(FACTORY[layer][i])) return []
      return [`${ind}${JSON.stringify(k.id)}: ${formatAction(a, ind)}`]
    })
    const body = entries.length ? `{\n${entries.join(',\n')}\n${IND.repeat(2)}}` : '{}'
    return `${IND.repeat(2)}${JSON.stringify(layer)}: ${body}`
  })
  field('layers', `{\n${layerTexts.join(',\n')}\n${IND}}`)

  if (p.library) {
    const groups = (['combos', 'macros', 'emulates'] as const)
      .filter((g) => p.library?.[g])
      .map((g) => `${IND.repeat(2)}${JSON.stringify(g)}: ${formatNamed(p.library![g]!, IND.repeat(2))}`)
    field('library', groups.length ? `{\n${groups.join(',\n')}\n${IND}}` : '{}')
  }
  if (p.backlight) {
    const entries = Object.entries(p.backlight).map(([k, v]) => `${IND.repeat(2)}${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    field('backlight', entries.length ? `{\n${entries.join(',\n')}\n${IND}}` : '{}')
  }
  return `{\n${lines.join(',\n')}\n}\n`
}
