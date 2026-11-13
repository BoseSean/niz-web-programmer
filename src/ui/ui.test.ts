import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FACTORY } from '../device/layout'
import { tableToProfile } from '../format/compile'
import { normalizeActionInput, normalizeProfile } from '../format/normalize'
import { parseProFile } from '../kb84/pro'
import { describePacket } from './lib/packets'
import { recordedSteps } from './lib/macro'
import { convertAction } from './lib/convert'
import { actionFace, noteZh, versionLabel } from './lib/describe'
import { exportPro, fileKind } from './lib/files'
import { issueMessageZh, issueTarget, issueWhere } from './lib/issues'
import { derive, editorReducer, initialEditorState } from './state/editor'
import { CODES } from '../device/codes'
import { keyById } from '../device/layout'
import { readRequest } from '../protocol/codec'

const hasLatin = (s: string) => /[A-Za-z]{4,}/.test(s.replace(/「[^」]*」|“[^”]*”|"[^"]*"|0x[0-9A-F]+/g, ''))

describe('issue translation', () => {
  const bad: unknown[] = [
    { type: 'combo', keys: ['KeyA'] },
    { type: 'combo', keys: ['KeyA', 'KeyA'] },
    { type: 'raw', packets: ['00F0013A0201010000' + '0036'.padEnd(110, '0')] }, // a 54-byte macro needs 2 packets
    { type: 'raw', packets: ['00F0013A02010100000036'.padEnd(128, '0'), '00F0013A02090100000036'.padEnd(128, '0')] },
    { type: 'combo', keys: ['KeyA', 'MouseDoubleClick'] },
    { type: 'emulate', keys: [], interval: 9000 },
    { type: 'macro', play: 'repeat', steps: [{ tap: 'KeyA' }] },
    { type: 'macro', play: 'hold', repeat: 2, interval: 30, steps: [{ wait: 5 }, { tap: 'KeyA' }] },
    { type: 'macro', play: 'repeat', repeat: 1, steps: [{ wait: 5 }, { down: 'KeyA' }, { down: 'KeyA' }, { up: 'KeyB' }, { wait: 70000 }] },
    { type: 'macro', play: 'repeat', repeat: 1, steps: [] },
    { type: 'raw', packets: ['00'] },
    { type: 'key', code: 'NoSuchKey' },
    { type: 'key', code: 222 },
    { type: 'bogus' },
  ]
  it('turns every validator message for edited actions into Chinese', () => {
    for (const input of bad) {
      const { issues } = normalizeActionInput(input, '/layers/base/caps')
      expect(issues.length).toBeGreaterThan(0)
      for (const i of issues) {
        const zh = issueMessageZh(i.message)
        expect(hasLatin(zh), `${i.message} -> ${zh}`).toBe(false)
      }
    }
  })

  it('translates profile-level warnings and locates them', () => {
    const p = tableToProfile(FACTORY)
    p.layers.base.fn = { type: 'key', code: 'KeyA' }
    const { issues } = normalizeProfile(p)
    expect(issues.map((i) => issueMessageZh(i.message))).toContain('基础层上没有任何 Fn 键，写入后将无法进入 Fn 层')
    const mirror = issues.find((i) => i.path === '/layers/fn/fn')!
    expect(issueMessageZh(mirror.message)).toMatch(/^“Fn”的Fn 层是 Fn/)
    expect(issueTarget('/layers/fn/j/steps/3')).toEqual({ layer: 'fn', keyId: 'j', sub: '/steps/3' })
    expect(issueWhere('/layers/fn/j/steps/3')).toBe('Fn 层 · J · 第 4 步')
    expect(issueWhere('/library/macros/0/action')).toBe('动作库 · 宏 第 1 项')
    expect(issueWhere('/library/emulates')).toBe('动作库 · 连发')
  })

  it('translates every code note', () => {
    for (const c of CODES) if (c.note) expect(hasLatin(noteZh(c.note)!.replace(/KB84|Fn\+[^）]+|Fn|Esc|Number Lock|84EC-S/g, '')), c.note).toBe(false)
  })
})

describe('macro recording', () => {
  const ev = (ref: string, dir: 'down' | 'up', t: number) => ({ ref, dir, t })
  const events = [ev('KeyA', 'down', 0), ev('KeyA', 'up', 80.4), ev('ShiftLeft', 'down', 200), ev('KeyB', 'down', 260), ev('KeyB', 'up', 300), ev('ShiftLeft', 'up', 350)]

  it('keeps real delays with recorded timing', () => {
    const steps = recordedSteps(events, true)
    expect(steps).toEqual([
      { down: 'KeyA' }, { wait: 80 }, { up: 'KeyA' }, { wait: 120 }, { down: 'ShiftLeft' }, { wait: 60 },
      { down: 'KeyB' }, { wait: 40 }, { up: 'KeyB' }, { wait: 50 }, { up: 'ShiftLeft' },
    ])
    expect(normalizeActionInput({ type: 'macro', play: 'repeat', repeat: 1, steps }).issues).toEqual([])
  })

  it('collapses press+release into taps for a fixed interval', () => {
    expect(recordedSteps(events, false)).toEqual([{ tap: 'KeyA' }, { down: 'ShiftLeft' }, { tap: 'KeyB' }, { up: 'ShiftLeft' }])
  })
})

describe('editor state', () => {
  it('coalesces typing into one undo step and supports undo/redo', () => {
    let s = initialEditorState()
    const edit = (interval: number, at: number) =>
      editorReducer(s, { type: 'setKey', layer: 'fn', keyId: 'j', action: { type: 'emulate', keys: ['KeyJ'], interval }, label: 'x', coalesce: 'fn/j/i', at })
    s = edit(3, 1000)
    s = edit(30, 1500)
    s = edit(300, 2000)
    expect(s.past).toHaveLength(1)
    s = editorReducer(s, { type: 'undo' })
    expect(s.present.layers.fn.j).toEqual({ type: 'none' })
    s = editorReducer(s, { type: 'redo' })
    expect(s.present.layers.fn.j).toEqual({ type: 'emulate', keys: ['KeyJ'], interval: 300 })
  })

  it('derives changed / pending status against factory and the device read', () => {
    const s = initialEditorState()
    const device = { base: [...FACTORY.base], fn: [...FACTORY.fn] }
    device.base[keyById('caps')!.no - 1] = { kind: 'codes', codes: [1] }
    const d = derive(s.present, device)
    expect(d.changedCount).toBe(0)
    expect(d.pendingCount).toBe(1)
    expect(d.status.base.caps).toMatchObject({ changed: false, pending: true })
    expect(d.table).not.toBeNull()
  })
})

describe('helpers', () => {
  it('converts between action types keeping codes', () => {
    const key = { type: 'key', code: 'KeyQ' } as const
    expect(convertAction(key, 'combo', 'KeyA')).toEqual({ type: 'combo', keys: ['KeyQ'] })
    expect(convertAction({ type: 'none' }, 'macro', 'KeyA')).toMatchObject({ steps: [{ tap: 'KeyA' }], interval: 30 })
    expect(convertAction({ type: 'combo', keys: ['ControlLeft', 'KeyC'] }, 'key', 'KeyA')).toEqual({ type: 'key', code: 'ControlLeft' })
  })

  it('shows short cap faces with tags', () => {
    const k = keyById('f1')!
    expect(actionFace({ type: 'key', code: 'AudioVolumeMute' }, k)).toEqual({ main: 'Mute', legend: 'F1', tag: '媒体' })
    expect(actionFace({ type: 'combo', keys: ['ControlLeft', 'ShiftLeft', 'Escape'] }, k).main).toBe('Ctrl+Sft+Esc')
  })

  it('reports .pro blockers and blanks those keys', () => {
    const p = tableToProfile(FACTORY)
    p.layers.fn.j = { type: 'raw', packets: [`00F0023600010100${'0'.repeat(112)}`] }
    p.layers.fn.k = { type: 'combo', keys: ['ControlLeft', 'Sleep'] }
    p.layers.fn.l = { type: 'macro', play: 'repeat', repeat: 1, interval: 30, steps: [{ tap: 'KeyA' }, { wait: 5 }, { tap: 'KeyB' }] }
    const { text, blockers } = exportPro(p)
    expect(blockers.map((b) => b.where)).toEqual(['Fn 层 · J', 'Fn 层 · K', 'Fn 层 · L'])
    // the glossary's words, as in the issues panel
    expect(blockers.map((b) => b.reason)).toEqual([
      '无法识别的键位不能保存到 .pro',
      'KB84 无法把这个代码放进列表（组合键 / 宏 / 连发）',
      '统一间隔的宏不能包含“等待”步骤（按键之间改用“逐步设置”）',
    ])
    const back = parseProFile(text)
    expect(back.profile?.layers.fn.j).toEqual({ type: 'none' })
    expect(back.profile?.layers.base.caps).toEqual({ type: 'key', code: 'CapsLock' })
  })

  it('names dropped library entries by their original position', () => {
    const p = tableToProfile(FACTORY)
    const combo = (keys: string[]) => ({ type: 'combo' as const, keys })
    p.library = {
      combos: [
        { name: 'ok', action: combo(['ControlLeft', 'KeyC']) },
        { name: 'bad1', action: combo(['ControlLeft', 'Sleep']) },
        { name: 'bad2', action: combo(['ShiftLeft', 'Sleep']) },
      ],
      emulates: [{ name: 'bad3', action: { type: 'emulate', keys: ['Sleep'], interval: 30 } }],
    }
    const { text, blockers } = exportPro(p)
    // named as in the issues panel and the 动作库 tab
    expect(blockers.map((b) => [b.path, b.where])).toEqual([
      ['/library/combos/1', '动作库 · 组合键 第 2 项'],
      ['/library/combos/2', '动作库 · 组合键 第 3 项'],
      ['/library/emulates/0', '动作库 · 连发 第 1 项'],
    ])
    expect(parseProFile(text).profile?.library?.combos?.map((c) => c.name)).toEqual(['ok'])
  })

  it('recognises file kinds and describes packets', () => {
    expect(fileKind('My.PRO')).toBe('pro')
    expect(fileKind('a.json')).toBe('json')
    expect(fileKind('a.txt')).toBeNull()
    expect(describePacket(readRequest())).toBe('读取请求')
    const slot = new Uint8Array(64)
    slot.set([0x00, 0xf0, 0x02, 54, 0x02])
    expect(describePacket(slot)).toBe('Fn 层 J · 宏')
  })
})

describe('versionLabel', () => {
  it('splits the F9 reply of a real 84EC-S and leaves other text alone', () => {
    expect(versionLabel('84EC(S)Pro BLe;V2.0.4;V2.0;')).toBe('84EC(S)Pro BLe · V2.0.4 · V2.0')
    expect(versionLabel('hex 01 02')).toBe('hex 01 02')
    expect(versionLabel(';;')).toBe(';;')
  })
})

// --- layout CSS (jsdom does no layout, so these check the numbers the layout is made of) -------------------------
const css = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const APP_CSS = css('./app.css')
const NOTICES_CSS = css('./components/Notices.css')
const KEYBOARD_CSS = css('./KeyboardView.css')

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Declarations of the first rule written with exactly this selector (list) at the start of a line. */
function rule(text: string, selector: string): string {
  const m = new RegExp(String.raw`(?:^|\n)\s*${escapeRe(selector)} \{([^}]*)\}`).exec(text)
  if (!m) throw new Error(`no rule ${selector}`)
  return m[1]
}
const decl = (body: string, prop: string) => new RegExp(String.raw`(?:^|[;\s])${prop}:\s*([^;]+);`).exec(body)?.[1].trim()
const zIndex = (text: string, selector: string) => Number(decl(rule(text, selector), 'z-index'))
/** A length of the form calc(var(--u) * a + b px), in px for one key unit u. */
function atU(value: string | undefined, u: number): number {
  const m = /^calc\(var\(--u\) \* ([\d.]+)(?: \+ ([\d.]+)px)?\)$/.exec(value ?? '')
  if (!m) throw new Error(`not a key-unit length: ${value}`)
  return Number(m[1]) * u + Number(m[2] ?? 0)
}

describe('layout CSS', () => {
  it('draws open menus over the 通信日志 and the notices, and keeps them inside the window', () => {
    const toolbar = zIndex(APP_CSS, '.toolbar')
    const log = zIndex(APP_CSS, '.log')
    const notices = zIndex(NOTICES_CSS, '.notice-stack')
    const noticesUnderMenu = zIndex(NOTICES_CSS, '.app:has(.menu-pop, .conn-pop, .mlight-pop) .notice-stack')
    // the toolbar's menus can only be as high as the toolbar
    expect(toolbar).toBeGreaterThan(log)
    expect(noticesUnderMenu).toBeLessThan(toolbar)
    expect(noticesUnderMenu).toBeGreaterThan(log)
    // with no menu open the notices stay over the toolbar; the connection popovers still hang over it
    expect(notices).toBeGreaterThan(toolbar)
    expect(zIndex(css('./components/ConnectionBar.css'), '.mlight-pop, .conn-pop')).toBeGreaterThan(toolbar)
    const pop = rule(APP_CSS, '.menu-pop')
    expect(decl(pop, 'max-height')).toMatch(/100vh - var\(--toolbar-h/)
    expect(decl(pop, 'overflow-y')).toBe('auto')
  })

  it('reserves the notice stack at the page bottom when the inspector is stacked under the board', () => {
    expect(decl(rule(NOTICES_CSS, '.notice-stack'), 'bottom')).toBe('var(--notice-bottom)')
    const narrow = NOTICES_CSS.slice(NOTICES_CSS.indexOf('@media (max-width: 980px)'))
    expect(decl(rule(narrow, '.notice-stack-list'), 'max-height')).toBe('var(--notice-max)')
    const pad = decl(rule(narrow, '.app:has(.notice-stack .notice)'), 'padding-bottom')
    expect(pad).toMatch(/^calc\(var\(--notice-bottom\) \+ var\(--notice-max\) \+ \d+px\)$/)
  })

  it('keeps the tag of a tagged key clear of the 未写入 dot', () => {
    const pad = (u: number) => atU(decl(rule(KEYBOARD_CSS, '.kb-key'), 'padding'), u)
    const dot = rule(KEYBOARD_CSS, '.kb-key.is-pending::after')
    const ring = Number(/0 0 0 ([\d.]+)px/.exec(decl(dot, 'box-shadow')!)![1])
    const tagTop = decl(rule(KEYBOARD_CSS, '.kb-tag'), 'top')
    const tagRight = decl(rule(KEYBOARD_CSS, '.kb-key.is-pending.has-tag .kb-tag'), 'right')
    for (const u of [30, 40, 64, 90]) {
      const r = atU(decl(dot, 'width'), u) / 2
      // the tag's top-right corner, from the key's top-right corner, against the ringed dot centred at (r, r)
      const dx = pad(u) + atU(tagRight, u) - r
      const dy = pad(u) + atU(tagTop, u) - r
      expect(Math.hypot(dx, dy), `u = ${u}px`).toBeGreaterThan(r + ring)
    }
  })
})
