import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codeById, codeByValue } from '../device/codes'
import { KEYS } from '../device/layout'
import { actionToSlot } from '../format/compile'
import { normalizeProfile } from '../format/normalize'
import type { MacroStep, NormalizedProfile } from '../format/types'
import { parseProFile, parseProLabel, toProFile } from './pro'
import { XmlError, parseXml } from './xml'

const RE_DIR = new URL('../../../docs/re/', import.meta.url)
const readDoc = (name: string) => readFileSync(new URL(name, RE_DIR), 'utf8')
const sample = (name: string) => readDoc(`samples/${name}`)

function parseOk(text: string): NormalizedProfile {
  const { profile, issues } = parseProFile(text)
  expect(issues).toEqual([])
  expect(profile).not.toBeNull()
  return profile!
}

/** Replaces the content of the CurrentSettings KEY (id, level) in a .pro text. */
function withKey(text: string, id: number, level: number, mode: number, list: string): string {
  const re = new RegExp(`<KEY ID="${id}" Level="${level}"[^>]*>\\r\\n<ComboKey>\\r\\n[\\s\\S]*?</ComboKey>`)
  expect(re.test(text)).toBe(true)
  return text.replace(re, `<KEY ID="${id}" Level="${level}" Mode="${mode}" HWCode="${id}">\r\n<ComboKey>\r\n${list}</ComboKey>`)
}

const item = (i: number, label: string) =>
  `<x ID="${i}" t1="${label}">\r\n<List SizeOfView="9" ViewStartAt="0" CursorPos="0" Cycles="1" IsAutoInterval="0" Delay="30" PlayMode="0"/>\r\n</x>\r\n`
const list = (attrs: string, labels: string[]) =>
  `<List SizeOfView="9" ViewStartAt="0" CursorPos="0" ${attrs}>\r\n${labels.map((l, i) => item(i, l)).join('')}</List>\r\n`

describe('KB84 label parser', () => {
  it('matches KB84 (labels.json, first match in appKey order) for every name and suffix', () => {
    const { entries } = JSON.parse(readDoc('labels.json')) as { entries: { name: string; code: number }[] }
    const kb84 = (label: string) =>
      entries.find((e) => label === e.name || label === `${e.name} UP` || label === `${e.name} Down`)?.code ?? 0
    for (const { name } of entries) {
      for (const label of [name, `${name} UP`, `${name} Down`]) {
        const p = parseProLabel(label)
        expect(p && 'code' in p ? p.code : 0, label).toBe(kb84(label))
      }
    }
  })

  it('parses delays, suffixes and quirks', () => {
    expect(parseProLabel('<187 ms>')).toEqual({ wait: 187 })
    expect(parseProLabel('Left SHIFT Down')).toEqual({ code: codeById('ShiftLeft')!.value, dir: 'down' })
    expect(parseProLabel('X UP')).toEqual({ code: codeById('KeyX')!.value, dir: 'up' })
    expect(parseProLabel('Mouse Down')).toEqual({ code: 129, dir: 'bare' }) // a proLabel, not "Mouse" + " Down"
    expect(parseProLabel('Power')).toEqual({ code: 77, dir: 'bare' })
    for (const bad of ['Sleep', 'Left CTRL', 'Left ALT', 'SHIFT', 'x', 'A up', '']) expect(parseProLabel(bad), bad).toBeNull()
  })
})

describe('parseProFile / toProFile round trips', () => {
  it('config.pro re-exports byte-for-byte', () => {
    const text = sample('config.pro')
    const profile = parseOk(text)
    expect(profile.name).toBeUndefined()
    expect(profile.library).toBeUndefined()
    expect(profile.backlight).toBeUndefined()
    expect(profile.layers.base.esc).toEqual({ type: 'key', code: 'Escape' })
    expect(profile.layers.base.fn).toEqual({ type: 'key', code: 'Fn' })
    expect(toProFile(profile)).toBe(text)
  })

  it('my_customer_mapping.pro (LF-only, third-party) re-exports identically after CRLF normalisation', () => {
    const text = sample('my_customer_mapping.pro')
    expect(text.includes('\r\n')).toBe(false) // why byte equality needs normalising: KB84 writes CRLF
    const profile = parseOk(text)
    expect(profile.layers.base.caps).toEqual({ type: 'key', code: 'Escape' })
    expect(profile.layers.fn.caps).toEqual({ type: 'key', code: 'CapsLock' })
    expect(profile.layers.base.rctrl).toEqual({ type: 'key', code: 'Insert' })
    expect(toProFile(profile)).toBe(text.replace(/\n/g, '\r\n'))
  })

  it('test.pro parses to the recorded test edits', () => {
    const profile = parseOk(sample('test.pro'))
    const fn = profile.layers.fn
    expect(fn.h).toEqual({ type: 'combo', keys: ['ShiftLeft', 'ControlLeft', 'KeyA'] })
    expect(fn.j).toEqual({
      type: 'macro',
      play: 'repeat',
      repeat: 2,
      interval: 30,
      steps: [{ down: 'KeyA' }, { up: 'KeyA' }, { down: 'KeyB' }, { up: 'KeyB' }, { down: 'KeyC' }, { up: 'KeyC' }],
    })
    expect(fn.k).toEqual({
      type: 'macro',
      play: 'repeat',
      repeat: 1,
      steps: [
        { down: 'KeyX' },
        { wait: 187 },
        { down: 'KeyY' },
        { wait: 349 },
        { up: 'KeyY' },
        { wait: 20 },
        { up: 'KeyX' },
      ],
    })
    expect(fn.l).toEqual({ type: 'emulate', keys: ['KeyZ'], interval: 30 })
    expect(fn.n).toEqual({ type: 'key', code: 'MouseLeft' })
    expect(profile.library).toEqual({
      combos: [{ name: '组合键1', action: fn.h }],
      macros: [
        { name: '宏定义1', action: fn.j },
        { name: 'k宏定义2', action: fn.k },
      ],
      emulates: [{ name: '模拟击键1', action: fn.l }],
    })
  })

  it('test.pro re-exports to a file that parses back to the same profile (here even byte-identical)', () => {
    const text = sample('test.pro')
    const profile = parseOk(text)
    const out = toProFile(profile)
    expect(parseOk(out)).toEqual(profile)
    expect(out).toBe(text)
  })

  it('accepts a BOM and LF line endings', () => {
    const text = sample('config.pro')
    expect(parseOk('﻿' + text.replace(/\r\n/g, '\n'))).toEqual(parseOk(text))
  })

  it('writes KB84 byte format details: CRLF everywhere, escaping, append rule, colours', () => {
    const profile = parseOk(sample('config.pro'))
    const names = ['a&b', '<x>', `"q'`, ...Array.from({ length: 8 }, (_, i) => `New Macro ${i + 3}`)]
    const step = { tap: 'KeyA' } as const
    profile.library = {
      macros: names.map((name) => ({ name, action: { type: 'macro', play: 'hold', steps: [step] } })),
    }
    profile.backlight = { esc: '#ff0010' }
    profile.layers.base.a = { type: 'macro', play: 'toggle', interval: 50, steps: [step, step] }
    const out = toProFile(profile)
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\r\n<KB84>\r\n')).toBe(true)
    expect(out.endsWith('</KB84>\r\n')).toBe(true)
    expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(out).toContain('<x ID="0" t1="a&amp;b">')
    expect(out).toContain('<x ID="1" t1="&lt;x&gt;">')
    expect(out).toContain('<x ID="2" t1="&quot;q&apos;">')
    // 11 entries in a 9-row view: ViewStartAt 2, CursorPos 8.
    expect(out).toContain(
      '<PredefinedMacro>\r\n<List SizeOfView="9" ViewStartAt="2" CursorPos="8" Cycles="1" IsAutoInterval="0" Delay="30" PlayMode="0">',
    )
    expect(out).toContain('<AREA ID="1" Red="255" Green="0" Blue="16"/>')
    expect(out).toContain(
      '<KEY ID="48" Level="0" Mode="3" HWCode="48">\r\n<ComboKey>\r\n' +
        '<List SizeOfView="9" ViewStartAt="0" CursorPos="3" Cycles="1" IsAutoInterval="1" Delay="50" PlayMode="2">\r\n' +
        '<x ID="0" t1="A Down">\r\n',
    )
    const back = parseOk(out)
    expect(back.backlight).toEqual({ esc: '#ff0010' })
    expect(back.layers.base.a).toEqual({
      type: 'macro',
      play: 'toggle',
      interval: 50,
      steps: [{ down: 'KeyA' }, { up: 'KeyA' }, { down: 'KeyA' }, { up: 'KeyA' }],
    })
    expect(back.library?.macros?.map((m) => m.name)).toEqual(names)
  })

  it('exports keys by code: Mode from the code category, unknown numbers as Mode 1, double click as 199', () => {
    const profile = parseOk(sample('config.pro'))
    profile.layers.fn.a = { type: 'key', code: 'MouseDoubleClick' }
    profile.layers.fn.s = { type: 'key', code: 222 }
    profile.layers.fn.d = { type: 'key', code: 'Sleep' }
    const out = toProFile(profile)
    expect(out).toContain('<KEY ID="48" Level="1" Mode="6" HWCode="199">')
    expect(out).toContain('<KEY ID="49" Level="1" Mode="1" HWCode="222">')
    expect(out).toContain('<KEY ID="50" Level="1" Mode="8" HWCode="76">')
    const back = parseOk(out)
    expect(back.layers.fn.a).toEqual({ type: 'key', code: 'MouseDoubleClick' })
    expect(back.layers.fn.s).toEqual({ type: 'key', code: 222 })
    expect(back.layers.fn.d).toEqual({ type: 'key', code: 'Sleep' })
  })

  it('writes recorded macros in KB84 key/<N ms> alternation', () => {
    const profile = parseOk(sample('config.pro'))
    profile.layers.fn.a = {
      type: 'macro',
      play: 'repeat',
      repeat: 3,
      steps: [{ tap: 'KeyA' }, { wait: 5 }, { wait: 7 }, { down: 'KeyB' }, { up: 'KeyB' }],
    }
    const out = toProFile(profile)
    const key = /<KEY ID="48" Level="1"[\s\S]*?<\/KEY>/.exec(out)![0]
    expect([...key.matchAll(/t1="([^"]*)"/g)].map((m) => m[1])).toEqual([
      'A Down', '&lt;0 ms&gt;', 'A UP', '&lt;12 ms&gt;', 'B Down', '&lt;0 ms&gt;', 'B UP',
    ])
    expect(key).toContain('Cycles="3" IsAutoInterval="0" Delay="30" PlayMode="0"')
    const back = parseProFile(out)
    expect(back.issues).toEqual([])
    expect(back.profile?.layers.fn.a).toEqual({
      type: 'macro',
      play: 'repeat',
      repeat: 3,
      steps: [{ down: 'KeyA' }, { wait: 0 }, { up: 'KeyA' }, { wait: 12 }, { down: 'KeyB' }, { wait: 0 }, { up: 'KeyB' }],
    })
    // Waits before the first / after the last event have no place on the device: dropped, as the wire encoder does.
    profile.layers.fn.a = { type: 'macro', play: 'repeat', repeat: 1, steps: [{ wait: 9 }, { tap: 'KeyA' }, { wait: 5 }] }
    const edges = /<KEY ID="48" Level="1"[\s\S]*?<\/KEY>/.exec(toProFile(profile))![0]
    expect([...edges.matchAll(/t1="([^"]*)"/g)].map((m) => m[1])).toEqual(['A Down', '&lt;0 ms&gt;', 'A UP'])
    profile.layers.fn.a = { type: 'macro', play: 'repeat', interval: 10, steps: [{ tap: 'KeyA' }, { wait: 5 }] }
    expect(() => toProFile(profile)).toThrow(/fixed interval/)
  })

  it('refuses what KB84 cannot store', () => {
    const base = parseOk(sample('config.pro'))
    const bad = (layers: NormalizedProfile['layers']['fn']) =>
      toProFile({ ...base, layers: { ...base.layers, fn: { ...base.layers.fn, ...layers } } })
    expect(() => bad({ a: { type: 'combo', keys: ['ControlLeft', 'Sleep'] } })).toThrow(/fn\/a\/keys\/1.*no KB84 label/)
    expect(() => bad({ a: { type: 'emulate', keys: [160], interval: 30 } })).toThrow(/no KB84 label/)
    expect(() => bad({ a: { type: 'raw', packets: [] } })).toThrow(/raw/)
    expect(() => bad({ a: { type: 'key', code: 'NoSuchKey' } })).toThrow(/unknown code/)
    expect(() => bad({ a: { type: 'combo', keys: ['ControlLeft', 'MouseDoubleClick'] } })).toThrow(/keys\/1.*no KB84 label/)
    expect(() => toProFile({ ...base, library: { combos: [{ name: 'm', action: { type: 'none' } }] } })).toThrow(
      /library\/combos\/0: a none action/,
    )
  })
})

describe('parseProFile errors and warnings', () => {
  const config = sample('config.pro')
  const errorsOf = (text: string) => {
    const { profile, issues } = parseProFile(text)
    expect(profile).toBeNull()
    return issues.filter((i) => i.severity === 'error').map((i) => i.message)
  }

  it('rejects a missing or out-of-order section', () => {
    const noMacro = config.replace(/<PredefinedMacro>[\s\S]*?<\/PredefinedMacro>\r\n/, '')
    expect(errorsOf(noMacro)).toEqual(['missing section <PredefinedMacro>'])
    const macro = /<PredefinedMacro>[\s\S]*?<\/PredefinedMacro>\r\n/.exec(config)![0]
    const swapped = config.replace(macro, '').replace('<PredefinedCombo>', macro + '<PredefinedCombo>')
    expect(errorsOf(swapped)).toEqual([expect.stringMatching(/<PredefinedMacro> is out of order/)])
  })

  it('rejects bad XML, a wrong root, a KEY without ComboKey and out-of-range ids', () => {
    expect(errorsOf(config.replace('</CurrentSettings>', ''))[0]).toMatch(/does not match/)
    expect(errorsOf('<?xml version="1.0"?>\r\n<KB85/>\r\n')).toEqual(['root element is <KB85>, expected <KB84>'])
    const noCombo = config.replace(
      /(<KEY ID="5" Level="0"[^>]*>)\r\n<ComboKey>\r\n[\s\S]*?<\/ComboKey>/,
      '$1',
    )
    expect(errorsOf(noCombo)).toEqual([expect.stringMatching(/KEY has no <ComboKey>/)])
    expect(errorsOf(config.replace('<KEY ID="84" Level="1"', '<KEY ID="85" Level="1"'))).toEqual([
      expect.stringMatching(/KEY ID must be 1\.\.84/),
    ])
    expect(errorsOf(config.replace('<AREA ID="3" ', '<AREA ID="85" '))).toEqual([
      expect.stringMatching(/AREA ID 85 is outside/),
    ])
    // AREA ID 0: KB84 stores it in an unused entry and never writes it back, so it is ignored with a warning
    const zero = parseProFile(config.replace('<AREA ID="3" ', '<AREA ID="0" '))
    expect(zero.profile).not.toBeNull()
    expect(zero.issues).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringMatching(/AREA ID 0 is not a key/) })])
  })

  it('reports unknown labels instead of sending code 0', () => {
    const text = withKey(config, 53, 1, 2, list('Cycles="1" IsAutoInterval="0" Delay="30" PlayMode="0"', ['Left CTRL', 'A']))
    const { profile, issues } = parseProFile(text)
    expect(profile).toBeNull()
    expect(issues).toEqual([
      {
        path: '/layers/fn/h/keys/0',
        message: 'unknown key label "Left CTRL" (KB84 would send code 0)',
        severity: 'error',
      },
    ])
    const sleep = withKey(config, 54, 1, 3, list('Cycles="1" IsAutoInterval="1" Delay="30" PlayMode="0"', ['Sleep Down']))
    expect(errorsOf(sleep)).toEqual([expect.stringMatching(/unknown key label "Sleep Down"/)])
    const delay = withKey(config, 54, 1, 3, list('Cycles="1" IsAutoInterval="1" Delay="30" PlayMode="0"', ['A', '&lt;5 ms&gt;', 'A']))
    expect(errorsOf(delay)).toEqual([expect.stringMatching(/delay item "<5 ms>" in a fixed-interval macro/)])
    const play = withKey(config, 54, 1, 3, list('Cycles="1" IsAutoInterval="1" Delay="30" PlayMode="3"', ['A']))
    expect(errorsOf(play)).toEqual(['PlayMode 3 is not 0, 1 or 2'])
  })

  it('infers bare macro items by toggle parity and warns about inconsistent suffixes', () => {
    // A device-read style macro: bare names with recorded delays.
    const read = withKey(config, 55, 1, 3, list('Cycles="3" IsAutoInterval="0" Delay="30" PlayMode="1"', ['Q', '&lt;10 ms&gt;', 'Q']))
    expect(parseOk(read).layers.fn.k).toEqual({ type: 'macro', play: 'hold', steps: [{ down: 'KeyQ' }, { wait: 10 }, { up: 'KeyQ' }] })

    const odd = withKey(config, 55, 1, 3, list('Cycles="1" IsAutoInterval="0" Delay="30" PlayMode="0"', ['Q Down', 'Q Down']))
    const { profile, issues } = parseProFile(odd)
    // The device toggles: the second Q releases it whatever the suffix says.
    expect(profile?.layers.fn.k).toEqual({ type: 'macro', play: 'repeat', repeat: 1, steps: [{ down: 'KeyQ' }, { up: 'KeyQ' }] })
    expect(issues.map((i) => [i.severity, i.path])).toEqual([
      ['warning', '/layers/fn/k/steps/1'],
      ['warning', '/layers/fn/k'],
    ])
  })

  it('treats empty lists and missing keys as empty with a warning, and ignores stale HWCode/lists', () => {
    const empty = withKey(config, 53, 1, 2, '<List SizeOfView="6" ViewStartAt="0" CursorPos="0" Cycles="1" IsAutoInterval="0" Delay="30" PlayMode="0"/>\r\n')
    const r1 = parseProFile(empty)
    expect(r1.profile?.layers.fn.h).toEqual({ type: 'none' })
    expect(r1.issues).toEqual([expect.objectContaining({ severity: 'warning', path: '/layers/fn/h' })])

    const missing = config.replace(/<KEY ID="2" Level="0"[^>]*>\r\n<ComboKey>\r\n[\s\S]*?<\/KEY>\r\n/, '')
    const r2 = parseProFile(missing)
    expect(r2.profile?.layers.base.f1).toEqual({ type: 'none' })
    expect(r2.issues).toEqual([expect.objectContaining({ severity: 'warning', path: '/layers/base/f1' })])

    // Stale list on a single-code key and a stale HWCode on an empty key: preserved by KB84, ignored here.
    const stale = withKey(config, 3, 0, 1, list('Cycles="1" IsAutoInterval="0" Delay="30" PlayMode="0"', ['Z'])).replace(
      '<KEY ID="3" Level="0" Mode="1" HWCode="3">',
      '<KEY ID="3" Level="0" Mode="0" HWCode="77">',
    )
    expect(parseOk(stale).layers.base.f2).toEqual({ type: 'none' })
  })

  it('covers every key on both layers', () => {
    const profile = parseOk(config)
    const ids = KEYS.map((k) => k.id).sort()
    for (const layer of ['base', 'fn'] as const) expect(Object.keys(profile.layers[layer]).sort()).toEqual(ids)
  })
})

describe('xml reader', () => {
  it('handles declarations, comments, entities, self-closing tags and both quote styles', () => {
    const root = parseXml(
      `<?xml version="1.0"?>\n<!-- c --><!DOCTYPE r>\n<r a='1 &amp; &#65;&#x42;' b="&lt;&gt;&quot;&apos;"><c/><d x="y"></d>text</r>\n`,
    )
    expect(root.name).toBe('r')
    expect(root.attrs.get('a')).toBe('1 & AB')
    expect(root.attrs.get('b')).toBe(`<>"'`)
    expect(root.children.map((c) => c.name)).toEqual(['c', 'd'])
    expect(root.children[1].line).toBe(3)
  })

  it('throws XmlError with a line number on malformed input', () => {
    for (const bad of ['<a>', '<a></b>', '<a x="1" x="2"/>', '<a x="&foo;"/>', '<a x="&amp"/>', '<a/><b/>', 'junk<a/>', '<a x=1/>', '']) {
      expect(() => parseXml(bad), bad).toThrow(XmlError)
    }
    expect(() => parseXml('<a>\n\n</b>')).toThrow(/line 3/)
  })
})

// --- golden data from the live capture ---------------------------------------------------------------------------

const LABELS = (JSON.parse(readDoc('labels.json')) as { entries: { name: string; code: number }[] }).entries

/** KB84's label parser 0x441db0, from labels.json (independent of parseProLabel). */
function kb84Value(label: string): number {
  if (label.includes('ms>')) return Number.parseInt(label.slice(1, label.length - 4), 10) || 0
  return LABELS.find((e) => label === e.name || label === `${e.name} UP` || label === `${e.name} Down`)?.code ?? 0
}

/** KB84's device conversion 0x442190: the setKeyConfiguration int array of every non-empty KEY, by "level:id". */
function kb84Arrays(text: string): Map<string, number[]> {
  const settings = parseXml(text).children.find((c) => c.name === 'CurrentSettings')!
  const out = new Map<string, number[]>()
  for (const key of settings.children) {
    const n = (el: typeof key, a: string) => Number(el.attrs.get(a))
    const list = key.children.find((c) => c.name === 'ComboKey')!.children[0]
    const v = list.children.map((x) => kb84Value(x.attrs.get('t1')!))
    const [cycles, auto, delay, pm] = ['Cycles', 'IsAutoInterval', 'Delay', 'PlayMode'].map((a) => n(list, a))
    const [mode, hw] = [n(key, 'Mode'), n(key, 'HWCode')]
    let d: number[]
    if (mode <= 0) continue
    else if (mode === 2) d = [0, v.length, ...v]
    else if (mode === 3) d = [2, pm, pm === 0 ? cycles : 0, auto ? 0 : 1, auto ? delay : 0, auto ? v.length : (v.length + 1) >> 1, ...v]
    else if (mode === 4) d = [1, delay, v.length, ...v]
    else d = hw === 199 ? [0, 2, 130, 130] : [0, 1, hw]
    out.set(`${n(key, 'Level')}:${n(key, 'ID')}`, d)
  }
  return out
}

type CaptureRecord = { kind: string; text?: string; layer?: number; key?: number; data?: number[] }
const CAPTURE = readDoc('live-capture.jsonl')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as CaptureRecord)

/** The setKey / getKey int arrays recorded after the marker that starts with `step`, by "level:id". */
function captured(step: string, kind: 'setKey' | 'getKey'): Map<string, number[]> {
  const start = CAPTURE.findIndex((r) => r.kind === 'marker' && r.text!.startsWith(`${step} `))
  const end = CAPTURE.findIndex((r, i) => i > start && r.kind === 'marker' && !r.text!.startsWith(`${step} `))
  const out = new Map<string, number[]>()
  for (const r of CAPTURE.slice(start, end < 0 ? undefined : end)) {
    if (r.kind === kind) out.set(`${r.layer}:${r.key}`, r.data!)
  }
  return out
}

/** Steps of a recorded macro int array, by toggle parity (the device's semantics). */
function recordedSteps(d: number[]): MacroStep[] {
  const held = new Set<number>()
  const steps: MacroStep[] = []
  for (let i = 6; i < d.length; i += 2) {
    const id = codeByValue(d[i])!.id
    steps.push(held.has(d[i]) ? { up: id } : { down: id })
    if (held.has(d[i])) held.delete(d[i])
    else held.add(d[i])
    if (i + 1 < d.length) steps.push({ wait: d[i + 1] })
  }
  return steps
}

describe('golden data from the live capture', () => {
  it('KB84 sends exactly the captured arrays for test.pro (STEP2) and config.pro (STEP5)', () => {
    const step2 = captured('STEP2', 'setKey')
    const step5 = captured('STEP5', 'setKey')
    expect([step2.size, step5.size]).toEqual([124, 119])
    // The reference converter reproduces the capture from the original files ...
    expect(kb84Arrays(sample('test.pro'))).toEqual(step2)
    expect(kb84Arrays(sample('config.pro'))).toEqual(step5)
    // ... and from our re-exports.
    expect(kb84Arrays(toProFile(parseOk(sample('test.pro'))))).toEqual(step2)
    expect(kb84Arrays(toProFile(parseOk(sample('config.pro'))))).toEqual(step5)
  })

  it('profiles authored in the Plum model export to files KB84 sends as captured (STEP2 test keys)', () => {
    const profile = parseOk(sample('config.pro'))
    Object.assign(profile.layers.fn, {
      h: { type: 'combo', keys: ['ShiftLeft', 'ControlLeft', 'KeyA'] },
      j: { type: 'macro', play: 'repeat', repeat: 2, interval: 30, steps: [{ tap: 'KeyA' }, { tap: 'KeyB' }, { tap: 'KeyC' }] },
      k: {
        type: 'macro',
        play: 'repeat',
        repeat: 1,
        steps: [{ down: 'KeyX' }, { wait: 187 }, { down: 'KeyY' }, { wait: 349 }, { up: 'KeyY' }, { wait: 20 }, { up: 'KeyX' }],
      },
      l: { type: 'emulate', keys: ['KeyZ'], interval: 30 },
      n: { type: 'key', code: 'MouseLeft' },
    } satisfies NormalizedProfile['layers']['fn'])
    expect(kb84Arrays(toProFile(profile))).toEqual(captured('STEP2', 'setKey'))
  })

  it('round-trips the captured 40-event recorded macro (STEP3d write / STEP3e read)', () => {
    const written = captured('STEP3d', 'setKey').get('1:55')!
    // The capture logs only the first 64 ints of a getKey buffer; the device returned the same macro.
    const readHead = captured('STEP3e', 'getKey').get('1:55')!
    expect(readHead).toEqual(written.slice(0, readHead.length))
    expect(written.slice(0, 6)).toEqual([2, 0, 1, 1, 0, 40])
    expect(written.length).toBe(6 + 2 * 40 - 1)
    const steps = recordedSteps(written)

    // Authored in the Plum model and exported: KB84 would send the captured array.
    const profile = parseOk(sample('config.pro'))
    profile.layers.fn.k = { type: 'macro', play: 'repeat', repeat: 1, steps }
    const out = toProFile(profile)
    expect(kb84Arrays(out).get('1:55')).toEqual(written)
    expect(parseOk(out).layers.fn.k).toEqual(profile.layers.fn.k)

    // The same macro as KB84 saves it after a device read: bare names and <N ms>; directions come from toggle parity.
    const labels = written.slice(6).map((v, i) => (i % 2 ? `&lt;${v} ms&gt;` : codeByValue(v)!.proLabel!))
    const deviceRead = withKey(sample('config.pro'), 55, 1, 3, list('Cycles="1" IsAutoInterval="0" Delay="0" PlayMode="0"', labels))
    const imported = parseOk(deviceRead)
    expect(imported.layers.fn.k).toEqual(profile.layers.fn.k)
    expect(kb84Arrays(deviceRead).get('1:55')).toEqual(written)
  })
})

describe('imports are valid Plum profiles', () => {
  const config = sample('config.pro')
  const valid = (p: NormalizedProfile) => {
    const { profile, issues } = normalizeProfile(JSON.parse(JSON.stringify(p)))
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(profile).toEqual(p)
  }

  it('the samples pass normalizeProfile unchanged', () => {
    for (const name of ['config.pro', 'test.pro', 'my_customer_mapping.pro']) valid(parseOk(sample(name)))
  })

  it('follows the device when a Down/UP suffix contradicts the toggle order', () => {
    const odd = withKey(config, 55, 1, 3, list('Cycles="1" IsAutoInterval="1" Delay="30" PlayMode="0"', ['Q UP', 'Q Down', 'W Down', 'W Down']))
    const { profile, issues } = parseProFile(odd)
    expect(profile!.layers.fn.k).toEqual({
      type: 'macro',
      play: 'repeat',
      repeat: 1,
      interval: 30,
      steps: [{ down: 'KeyQ' }, { up: 'KeyQ' }, { down: 'KeyW' }, { up: 'KeyW' }],
    })
    expect(issues.map((i) => i.path)).toEqual(['/layers/fn/k/steps/0', '/layers/fn/k/steps/1', '/layers/fn/k/steps/3'])
    valid(profile!)
  })

  it('imports a one-key combo as a key and keeps repeated combo keys (as KB84 sends them)', () => {
    const one = parseProFile(withKey(config, 53, 1, 2, list('Cycles="1" IsAutoInterval="0" Delay="30" PlayMode="0"', ['A'])))
    expect(one.issues).toEqual([])
    expect(one.profile!.layers.fn.h).toEqual({ type: 'key', code: 'KeyA' })
    const dup = parseProFile(
      withKey(config, 53, 1, 2, list('Cycles="1" IsAutoInterval="0" Delay="30" PlayMode="0"', ['Left SHIFT', 'A', 'Left SHIFT'])),
    )
    expect(dup.profile!.layers.fn.h).toEqual({ type: 'combo', keys: ['ShiftLeft', 'KeyA', 'ShiftLeft'] })
    expect(dup.issues).toEqual([expect.objectContaining({ severity: 'warning', path: '/layers/fn/h/keys' })])
    // the bytes KB84 would send for this list: [0, 3, 0x37, 0x2B, 0x37]
    expect(actionToSlot(dup.profile!.layers.fn.h)).toEqual({ kind: 'codes', codes: [0x37, 0x2b, 0x37] })
    const twice = parseProFile(withKey(config, 53, 1, 2, list('Cycles="1" IsAutoInterval="0" Delay="30" PlayMode="0"', ['A', 'A'])))
    expect(twice.profile!.layers.fn.h).toEqual({ type: 'combo', keys: ['KeyA', 'KeyA'] })
    valid(dup.profile!)
    valid(twice.profile!)
  })

  it('rejects values the device or the Plum format cannot hold', () => {
    const errorsOf = (attrs: string, labels: string[], mode = 3) =>
      parseProFile(withKey(config, 55, 1, mode, list(attrs, labels)))
        .issues.filter((i) => i.severity === 'error')
        .map((i) => i.message)
    const rec = 'Cycles="1" IsAutoInterval="0" Delay="30" PlayMode="0"'
    expect(errorsOf(rec, ['Left SHIFT', 'Left Double Click'], 2)).toEqual([expect.stringMatching(/Left Double Click.*0xC7/)])
    expect(errorsOf(rec, ['Left Double Click Down'])).toEqual([expect.stringMatching(/0xC7/)])
    expect(errorsOf('Cycles="0" IsAutoInterval="1" Delay="30" PlayMode="0"', ['A'])).toEqual(['Cycles 0 is outside 1..255'])
    expect(errorsOf('Cycles="0" IsAutoInterval="1" Delay="30" PlayMode="1"', ['A', 'A'])).toEqual([]) // hold: Cycles unused
    expect(errorsOf('Cycles="1" IsAutoInterval="1" Delay="60001" PlayMode="0"', ['A'])).toEqual(['Delay 60001 is outside 0..60000'])
    expect(errorsOf(rec, ['A', '&lt;65536 ms&gt;', 'A'])).toEqual(['delay 65536 is outside 0..65535'])
    expect(errorsOf(rec, ['A', '&lt;-1 ms&gt;', 'A'])).toEqual(['delay -1 is outside 0..65535'])
    expect(errorsOf(rec, ['&lt;5 ms&gt;'])).toEqual(['macro has no key events'])
    expect(errorsOf('Cycles="1" IsAutoInterval="0" Delay="6001" PlayMode="0"', ['Z'], 4)).toEqual(['Delay 6001 is outside 0..6000'])
    expect(errorsOf(rec, ['A', 'B', 'C', 'D', 'E', 'F', 'G'], 4)).toEqual(['key count 7 is outside 1..6'])
  })

  it('skips library entries that cannot be represented (empty, one-key combo) with a warning', () => {
    const profile = parseOk(config)
    const combos = [
      { name: 'empty', action: { type: 'combo', keys: [] } },
      { name: 'one', action: { type: 'combo', keys: ['KeyA'] } },
      { name: 'ok', action: { type: 'combo', keys: ['KeyA', 'KeyB'] } },
    ] satisfies NonNullable<NormalizedProfile['library']>['combos']
    profile.library = { combos }
    const { profile: back, issues } = parseProFile(toProFile(profile))
    expect(back!.library).toEqual({ combos: [combos[2]], macros: [], emulates: [] })
    expect(issues.map((i) => [i.severity, i.path])).toEqual([
      ['warning', '/library/combos/0'],
      ['warning', '/library/combos/1'],
    ])
  })

  it('exports library entries into the section of their action type', () => {
    const profile = parseOk(config)
    const macro = (steps: MacroStep[]) => ({ name: 'm', action: { type: 'macro', play: 'hold', interval: 5, steps } }) as const
    profile.library = { combos: [macro([{ tap: 'KeyA' }])] }
    const back = parseOk(toProFile(profile))
    expect(back.library).toEqual({ combos: [], macros: [macro([{ down: 'KeyA' }, { up: 'KeyA' }])], emulates: [] })
  })
})
