/**
 * Keeps docs/PROTOCOL.md, docs/FORMAT.md and README.md honest: every generated table must equal the code's data,
 * every quoted wire payload must exist in the live capture (or be a known code-derived example), every JSON example
 * must validate, and every relative link and anchor must resolve.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CODES, codeById } from './device/codes'
import { FACTORY, KEYS } from './device/layout'
import { actionToSlot } from './format/compile'
import { normalizeActionInput, normalizeProfile } from './format/normalize'
import { decodeSlotPackets, encodeSlot } from './protocol/codec'
import type { Slot } from './protocol/slots'

const ROOT = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8')
const PROTOCOL = read('docs/PROTOCOL.md')
const FORMAT = read('docs/FORMAT.md')
const README = read('README.md')

/** Body of the `## <n>.` section (up to the next `## ` heading). */
function section(doc: string, n: string): string {
  const start = doc.indexOf(`\n## ${n}. `)
  expect(start, `section ${n}`).toBeGreaterThan(0)
  const end = doc.indexOf('\n## ', start + 1)
  return doc.slice(start, end < 0 ? undefined : end)
}

/** Cells of the markdown table rows in `text` whose first cell matches `first`. */
function rows(text: string, first: RegExp): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.startsWith('| '))
    .map((l) => l.slice(1, -1).split('|').map((c) => c.trim()))
    .filter((c) => first.test(c[0]))
}

/** Text of an inline-code cell: `x`, `` ` `` or plain text. */
const code = (cell: string) => cell.replace(/^``? ?(.*?) ?``?$/, '$1')
const unescapeMd = (s: string) => s.replace(/\\([`\\*])/g, '$1')
const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0')

function packet(hex: string): Uint8Array {
  const p = new Uint8Array(64)
  p.set(hex.trim().split(/\s+/).map((b) => parseInt(b, 16)))
  return p
}
const toHex = (p: Uint8Array) => Array.from(p, hex2).join(' ')

/** Every 64-byte payload in the live capture, by direction. */
const CAPTURE = (() => {
  const out = { W: new Set<string>(), R: new Set<string>() }
  for (const line of read('docs/re/live-capture.jsonl').split(/\r?\n/)) {
    if (!line) continue
    const e = JSON.parse(line) as { kind: string; data?: string }
    if ((e.kind === 'W' || e.kind === 'R') && e.data) out[e.kind].add(toHex(packet(e.data.match(/../g)!.slice(1).join(' '))))
  }
  return out
})()

/** Slot packets of the given step (the capture's marker text starts with it). */
function stepPackets(step: string, kind: 'W' | 'R'): Uint8Array[] {
  const out: Uint8Array[] = []
  let current = ''
  for (const line of read('docs/re/live-capture.jsonl').split(/\r?\n/)) {
    if (!line) continue
    const e = JSON.parse(line) as { kind: string; data?: string; text?: string }
    if (e.kind === 'marker') current = e.text!.split(' ')[0]
    if (current === step && e.kind === kind && e.data) out.push(packet(e.data.match(/../g)!.slice(1).join(' ')))
  }
  return out
}

describe('PROTOCOL.md generated tables', () => {
  it('§14 key table equals KEYS', () => {
    const r = rows(section(PROTOCOL, '14'), /^\d+$/)
    expect(r).toHaveLength(84)
    r.forEach((c, i) => {
      const k = KEYS[i]
      const label = c[3] === '（空格键）' ? '' : unescapeMd(code(c[3]))
      expect([+c[0], c[1], code(c[2]), label, code(c[4]), +c[5], +c[6], +c[7]], `key ${i + 1}`).toEqual([
        k.no,
        hex2(k.no),
        k.id,
        k.label,
        k.sub ?? '',
        k.row,
        k.x,
        k.w,
      ])
    })
  })

  it('§15 code tables equal CODES (value, id, category, zh, .pro label)', () => {
    const text = section(PROTOCOL, '15')
    const groups = text.split('\n#### ').slice(1)
    let total = 0
    for (const g of groups) {
      const [, category, count] = /：`(\w+)`（(\d+) 个/.exec(g)!
      const r = rows(g, /^\d+$/)
      expect(r, category).toHaveLength(+count)
      total += r.length
      for (const c of r) {
        const info = CODES.find((x) => x.value === +c[0])
        expect(info, `code ${c[0]}`).toBeDefined()
        expect([c[1], code(c[2]), category, unescapeMd(c[3]), c[4] === '—' ? null : unescapeMd(code(c[4]))]).toEqual([
          hex2(info!.value),
          info!.id,
          info!.category,
          info!.zh,
          info!.proLabel,
        ])
      }
    }
    expect(total).toBe(CODES.length)
  })

  it('§16 factory table equals FACTORY', () => {
    const r = rows(section(PROTOCOL, '16'), /^\d+$/)
    expect(r).toHaveLength(84)
    const cell = (s: string): Slot => {
      const m = /`(\w+)` (\d+)/.exec(s)
      if (!m) return { kind: 'empty' }
      expect(codeById(m[1])?.value, s).toBe(+m[2])
      return { kind: 'codes', codes: [+m[2]] }
    }
    r.forEach((c, i) => {
      expect(code(c[1])).toBe(KEYS[i].id)
      expect(cell(c[3]), `base ${c[1]}`).toEqual({ ...FACTORY.base[i] })
      expect(cell(c[4]), `fn ${c[1]}`).toEqual(FACTORY.fn[i].kind === 'empty' ? FACTORY.fn[i] : { ...FACTORY.fn[i] })
    })
    const defined = FACTORY.fn.filter((s) => s.kind !== 'empty').length
    expect(section(PROTOCOL, '16')).toContain(`Fn 层：${defined} 个键有定义`)
  })
})

describe('PROTOCOL.md wire examples', () => {
  /** Payloads derived from KB84's code, never captured. */
  const CODE_DERIVED = new Set(['00 F0 01 01 00 02 82 82'])

  it('every quoted single-packet slot payload is in the capture and decodes cleanly', () => {
    const quoted = [...PROTOCOL.matchAll(/`(00 F0 0[12] [0-9A-F]{2}(?: [0-9A-F]{2})+)`/g)].map((m) => m[1])
    expect(quoted.length).toBeGreaterThan(10)
    for (const hex of new Set(quoted)) {
      const p = packet(hex)
      if (!CODE_DERIVED.has(hex)) expect(CAPTURE.W.has(toHex(p)) || CAPTURE.R.has(toHex(p)), hex).toBe(true)
      expect(decodeSlotPackets([p]).slot.kind, hex).not.toBe('raw')
    }
  })

  it('§19 transcript lines are captured packets in the stated direction', () => {
    const lines = [...section(PROTOCOL, '19').matchAll(/^([WR])  00 \| ((?:[0-9A-F]{2} )*[0-9A-F]{2})(?= {2,}|$)/gm)]
    expect(lines.length).toBeGreaterThan(10)
    for (const [, dir, hex] of lines) expect(CAPTURE[dir as 'W' | 'R'].has(toHex(packet(hex))), `${dir} ${hex}`).toBe(true)
  })

  it('§10.4 prints the three STEP3e packets of the 157-byte macro byte for byte', () => {
    const block = /包 1[\s\S]*?```/.exec(section(PROTOCOL, '10'))![0]
    const printed = block
      .split(/\n\s*\n/)
      .map((chunk) => chunk.split('\n').filter((l) => /^[0-9A-F]{2} /.test(l)).join(' ').replace('|', ' '))
      .filter(Boolean)
      .map(packet)
    const captured = stepPackets('STEP3e', 'R').filter((p) => p[1] === 0xf0 && p[2] === 2 && p[3] === 0x37)
    expect(printed.map(toHex)).toEqual(captured.map(toHex))
    expect(stepPackets('STEP3d', 'W').filter((p) => p[1] === 0xf0 && p[2] === 2 && p[3] === 0x37).map(toHex)).toEqual(
      captured.map(toHex),
    )
  })

  it('timing and report counts quoted in §7 / §19.5 match the capture', () => {
    // Key traffic only: the light read's `E2` request and `E6×64` answer are excluded.
    const op = (step: string, kind: 'W' | 'R') =>
      stepPackets(step, kind).filter((p) => p[0] !== 0xe6 && !(p[0] === 0 && p[1] === 0xe2)).length
    expect([op('STEP2', 'W'), op('STEP3d', 'W'), op('STEP1', 'R'), op('STEP3e', 'R')]).toEqual([170, 172, 169, 171])
    for (const s of ['170 个报告（`F1` + 168 个槽位 + `F6`）用时 1386 ms', '| 写入（含 3 包宏） | 172 | 1420 ms |'])
      expect(PROTOCOL).toContain(s)
  })
})

describe('FORMAT.md examples and claims', () => {
  const jsonBlocks = [...FORMAT.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1].trim())

  it('every JSON example validates (profiles, layer maps, fragments and single actions)', () => {
    expect(jsonBlocks.length).toBeGreaterThan(8)
    for (const text of jsonBlocks) {
      if (text.includes('…')) continue // the raw placeholder
      const value = JSON.parse(text.startsWith('"') ? `{${text}}` : text) as Record<string, unknown>
      const issues =
        'format' in value
          ? normalizeProfile(value).issues
          : 'type' in value
            ? normalizeActionInput(value).issues
            : normalizeProfile({
                format: 'plum-keymap',
                version: 1,
                device: '84EC-S',
                inherit: 'factory',
                ...value,
                layers: 'layers' in value ? value.layers : { base: value.base ?? {}, fn: value.fn ?? {} },
              }).issues
      expect(issues.filter((i) => i.severity === 'error'), text).toEqual([])
    }
  })

  it('§12 full example compiles to the payloads in its comments, and the Fn ones are the STEP2 bytes', () => {
    const block = /```jsonc\n([\s\S]*?)```/.exec(section(FORMAT, '12'))![1]
    const comments = [...block.matchAll(/\/\/ ((?:[0-9A-F]{2} ?)+)$/gm)].map((m) => m[1].trim())
    const { profile, issues } = normalizeProfile(JSON.parse(block.replace(/\/\/.*$/gm, '')))
    expect(issues).toEqual([])
    const targets = [['base', 'caps'], ['fn', 'h'], ['fn', 'j'], ['fn', 'k'], ['fn', 'l'], ['fn', 'n']] as const
    expect(comments).toHaveLength(targets.length)
    targets.forEach(([layer, id], i) => {
      const key = KEYS.find((k) => k.id === id)!
      const [p] = encodeSlot(layer === 'base' ? 1 : 2, key.no, actionToSlot(profile!.layers[layer][id]))
      expect(toHex(p)).toBe(toHex(packet(comments[i])))
      if (layer === 'fn') expect(CAPTURE.W.has(toHex(p)), id).toBe(true)
    })
  })

  it('§4 key-id rows list KEYS in row order', () => {
    const r = rows(section(FORMAT, '4'), /^\d$/)
    expect(r).toHaveLength(6)
    r.forEach((c) => expect(c[1].split(/\s+/).map(code)).toEqual(KEYS.filter((k) => k.row === +c[0]).map((k) => k.id)))
  })

  const base = { format: 'plum-keymap', version: 1, device: '84EC-S', inherit: 'factory' } as const
  const severityOf = (input: object, path: string) =>
    normalizeProfile({ ...base, ...input }).issues.find((i) => i.path.startsWith(path))?.severity

  it('severities stated in §6–§11 are the validator\'s', () => {
    const rawFor = (l: string, k: string) => ({ type: 'raw', packets: [`00F0${l}${k}`.padEnd(128, '0')] })
    expect(severityOf({ layers: { base: {}, fn: { h: rawFor('01', '35') } } }, '/layers/fn/h')).toBe('error')
    expect(severityOf({ layers: { base: {}, fn: { h: rawFor('02', '35') } } }, '/layers/fn/h')).toBeUndefined()
    const combo = { type: 'combo', keys: ['KeyA', 'KeyA'] }
    expect(severityOf({ layers: { base: {}, fn: { h: combo } } }, '/layers/fn/h')).toBe('warning')
    const halfMacro = { type: 'raw', packets: ['00F0023502010100000036'.padEnd(128, '0')] }
    expect(severityOf({ layers: { base: {}, fn: { h: halfMacro } } }, '/layers/fn/h')).toBe('error')
    const lib = { macros: [{ name: 'x', action: { type: 'combo', keys: ['KeyA', 'KeyB'] } }] }
    expect(severityOf({ layers: { base: {}, fn: {} }, library: lib }, '/library')).toBe('error')
    expect(severityOf({ layers: { base: {}, fn: {} }, backlight: { nokey: '#ffffff' } }, '/backlight')).toBe('error')
    expect(severityOf({ layers: { base: { fn: 'KeyA' }, fn: {} } }, '/layers/base')).toBe('warning')
    expect(FORMAT).not.toMatch(/\| raw \| 包头不是所在位置/)
  })
})

describe('links', () => {
  /** GitHub heading anchor. */
  const slug = (h: string) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\- _]/gu, '')
      .replace(/ /g, '-')
  const anchors = (doc: string) => new Set([...doc.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])))

  it.each([
    ['README.md', README],
    ['docs/PROTOCOL.md', PROTOCOL],
    ['docs/FORMAT.md', FORMAT],
  ])('%s: relative links and anchors resolve', (path, doc) => {
    const dir = new URL(path.replace(/[^/]+$/, ''), ROOT)
    for (const [, target] of doc.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target)) continue
      const [file, anchor] = target.split('#')
      const url = file ? new URL(file, dir) : new URL(path, ROOT)
      expect(existsSync(url), target).toBe(true)
      if (anchor) expect(anchors(readFileSync(url, 'utf8')).has(decodeURIComponent(anchor)), target).toBe(true)
    }
  })
})
