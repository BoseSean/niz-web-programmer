/** Chinese labels and short descriptions of codes and actions for the editor UI. */
import { codeLabel, codeShort, resolveCodeRef } from '../../device/codes'
import type { CodeCategory, CodeInfo, KeyInfo, LayerId } from '../../device/types'
import type { Action, CodeRef, MacroPlay, MacroStep } from '../../format/types'

type Macro = Extract<Action, { type: 'macro' }>
type KeyStep = Exclude<MacroStep, { wait: number }>

export const LAYER_ZH: Record<LayerId, string> = { base: '基础层', fn: 'Fn 层' }

export const ACTION_ZH: Record<Action['type'], string> = {
  none: '无',
  key: '按键',
  combo: '组合键',
  macro: '宏',
  emulate: '连发',
  raw: '无法识别',
}

export const CATEGORY_ZH: Record<CodeCategory, string> = {
  key: '键盘',
  media: '多媒体',
  mouse: '鼠标',
  function: '键盘功能',
  power: '电源',
  special: '未知功能',
}

const CATEGORY_TAG: Record<CodeCategory, string | undefined> = {
  key: undefined,
  media: '媒体',
  mouse: '鼠标',
  function: '功能',
  power: '电源',
  special: '未知',
}

export const PLAY_ZH: Record<MacroPlay, string> = { repeat: '按一下播放', hold: '按住时播放', toggle: '按一下开/关' }

/** English code notes from codes.ts, translated phrase by phrase. */
const NOTE_PHRASES: [RegExp, string | ((...m: string[]) => string)][] = [
  [/^KB84 cannot place Sleep inside lists.*$/, 'KB84 无法在组合键、宏、连发里使用睡眠键'],
  [/^KB84 displays it as "-- --"$/, 'KB84 中显示为 "-- --"'],
  [/^Backlight function; the 84EC-S has no backlight$/, '背光功能；84EC-S 没有背光，按下无效果'],
  [/^Backlight function$/, '背光功能'],
  [/^the 84EC-S has no backlight$/, '84EC-S 没有背光，按下无效果'],
  [/^Meaning on 84EC-S unverified \(KB84 backlight-era name\)$/, '在 84EC-S 上的实际作用未验证（名称沿用 KB84 的背光型号）'],
  [/^Meaning on 84EC-S unverified \(KB84 name\)$/, '在 84EC-S 上的实际作用未验证（名称沿用 KB84）'],
  [/^Meaning on 84EC-S unverified$/, '在 84EC-S 上的实际作用未验证'],
  [/^not offered by KB84 \(preserved when read\)$/, 'KB84 不提供此项（读取时原样保留）'],
  [/^KB84 name "Number Lock"$/, 'KB84 中名为 "Number Lock"'],
  [/^the 84EC-S manual: Fn\+Esc locks the number row$/, '84EC-S 说明书：Fn+Esc 锁定数字行'],
  [/^Set it on both layers of the same key \(KB84 mirrors it\)$/, '请在同一个键的两层都设置 Fn（KB84 也会自动同步）'],
  [
    /^Hold about 2 s to toggle Office.*$/,
    '按住约 2 秒切换办公模式（出厂键位）/ 编程模式（你写入的键位）；编程模式下 M 灯亮',
  ],
  [/^the M light is on in Program mode$/, ''],
  [/^Unknown device function, preserved \(factory (.+)\)$/, (_, where) => `未知功能，原样保留（出厂位于 ${where}）`],
  [/^Sent as two left clicks.*$/, '发送为两次鼠标左键单击'],
]

export function noteZh(note: string | undefined): string | undefined {
  if (!note) return undefined
  return note
    .split('; ')
    .map((part) => {
      for (const [re, zh] of NOTE_PHRASES) {
        const m = re.exec(part)
        if (m) return typeof zh === 'string' ? zh : zh(...m)
      }
      return part
    })
    .filter(Boolean)
    .join('；')
}

/** A code that does nothing on this keyboard (backlight functions: the 84EC-S has no backlight). */
export function isNoEffect(info: CodeInfo | undefined): boolean {
  return !!info && /no backlight/.test(info.note ?? '')
}

/**
 * A code whose effect on this keyboard is unknown or not verified (and every code the device data does not know).
 * Codes the 84EC-S manual documents, such as NumberRowLock, are not unverified even when KB84 does not offer them.
 */
export function isUnverified(info: CodeInfo | undefined): boolean {
  if (!info) return true
  return !isNoEffect(info) && /unverified|Unknown device/.test(info.note ?? '')
}

/** A code shown with a caution badge: no effect, or an unverified one. */
export function isUncertain(info: CodeInfo | undefined): boolean {
  return isNoEffect(info) || isUnverified(info)
}

export const codeZh = (ref: CodeRef) => codeLabel(ref, 'zh')

const CAP_ALIASES: Record<string, string> = { Shift: 'Sft' }
const capShort = (ref: CodeRef) => {
  const s = codeShort(ref)
  return CAP_ALIASES[s] ?? s
}

export function codesOf(a: Action): CodeRef[] {
  switch (a.type) {
    case 'key':
      return [a.code]
    case 'combo':
    case 'emulate':
      return a.keys
    case 'macro': {
      const seen = new Map<string, CodeRef>()
      for (const s of a.steps) {
        if ('wait' in s) continue
        const ref = stepCode(s)
        seen.set(String(ref), ref)
      }
      return [...seen.values()]
    }
    default:
      return []
  }
}

export function stepCode(s: KeyStep): CodeRef {
  return 'tap' in s ? s.tap : 'down' in s ? s.down : s.up
}

/** Number of toggle events (wire bytes for a fixed-interval macro). */
export function macroEventCount(steps: readonly MacroStep[]): number {
  return steps.reduce((n, s) => n + ('tap' in s ? 2 : 'wait' in s ? 0 : 1), 0)
}

export interface Face {
  main: string
  legend?: string
  tag?: string
}

/** What a key cap shows for an action. */
export function actionFace(a: Action, key: KeyInfo): Face {
  const legend = key.label
  switch (a.type) {
    case 'none':
      return { main: '', legend }
    case 'key': {
      const info = resolveCodeRef(a.code)?.info
      return { main: codeShort(a.code), legend, tag: info ? CATEGORY_TAG[info.category] : '未知' }
    }
    case 'combo':
      return { main: a.keys.map(capShort).join('+') || '组合', legend, tag: '组合' }
    case 'emulate':
      return { main: a.keys.map(capShort).join(' ') || '连发', legend, tag: '连发' }
    case 'macro': {
      const codes = codesOf(a)
      const main = codes.slice(0, 3).map(capShort).join(' ') + (codes.length > 3 ? '…' : '')
      return { main: main || '宏', legend, tag: '宏' }
    }
    case 'raw':
      return { main: '?', legend, tag: '未识别' }
  }
}

type MacroItem = { down: CodeRef } | { up: CodeRef } | { wait: number }

/** A code reference as a comparable key ("ControlLeft" and 67 are the same code). */
const sameCode = (ref: CodeRef) => String(resolveCodeRef(ref)?.value ?? ref)

/** Steps as single press / release events (a tap is a press directly followed by its release) and waits. */
function macroItems(steps: readonly MacroStep[]): MacroItem[] {
  return steps.flatMap((s): MacroItem[] => ('tap' in s ? [{ down: s.tap }, { up: s.tap }] : [s]))
}

/**
 * Keys pressed together at `start`: a run of presses followed by the releases of exactly those keys, with nothing
 * else in between but waits (the hold times, left out of the label). "Ctrl+C" for press Ctrl, tap C, release Ctrl.
 */
function chordAt(items: readonly MacroItem[], start: number): { label: string; end: number } | null {
  if (!('down' in items[start])) return null
  const down: string[] = []
  const refs: CodeRef[] = []
  let i = start
  for (; i < items.length; i++) {
    const it = items[i]
    if ('up' in it) break
    if ('down' in it) {
      if (down.includes(sameCode(it.down))) return null
      down.push(sameCode(it.down))
      refs.push(it.down)
    }
  }
  const up = new Set<string>()
  let end = i
  for (; i < items.length && up.size < down.length; i++) {
    const it = items[i]
    if ('down' in it) return null
    if ('up' in it) {
      if (!down.includes(sameCode(it.up)) || up.has(sameCode(it.up))) return null
      up.add(sameCode(it.up))
      end = i + 1
    }
  }
  return up.size === down.length ? { label: refs.map(codeShort).join('+'), end } : null
}

/**
 * What a macro types, in order: "Ctrl+C → 停 100 ms → V". Keys pressed together read "Ctrl+C", other presses and
 * releases "按住 X" / "松开 X", waits between keys "停 n ms"; after `max` items the rest is "…".
 */
export function macroPreview(a: Macro, max = 4): string {
  const items = macroItems(a.steps)
  const out: string[] = []
  for (let i = 0; i < items.length; ) {
    const chord = chordAt(items, i)
    if (chord) {
      out.push(chord.label)
      i = chord.end
      continue
    }
    const it = items[i++]
    if ('wait' in it) {
      if (it.wait > 0) out.push(`停 ${it.wait} ms`)
    } else out.push('down' in it ? `按住 ${codeShort(it.down)}` : `松开 ${codeShort(it.up)}`)
  }
  return out.length > max ? `${out.slice(0, max).join(' → ')} → …` : out.join(' → ')
}

/**
 * How long one pass of a macro takes, in ms: (events − 1) × interval with a fixed interval, else the waits between
 * events (a wait before the first or after the last event is ignored, as on the keyboard).
 */
export function macroDurationMs(a: Macro): number {
  const events = macroEventCount(a.steps)
  if (a.interval !== undefined) return Math.max(0, events - 1) * a.interval
  let total = 0
  let pending = 0
  let seen = false
  for (const s of a.steps) {
    if ('wait' in s) pending += s.wait
    else {
      if (seen) total += pending
      pending = 0
      seen = true
    }
  }
  return total
}

/** One-line Chinese description of an action (dialogs, inspector context lines). */
export function describeAction(a: Action): string {
  switch (a.type) {
    case 'none':
      return '无'
    case 'key':
      return codeZh(a.code)
    case 'combo':
      return a.keys.length ? a.keys.map(codeZh).join(' + ') : '组合键（空）'
    case 'emulate':
      return `连发 ${a.keys.map(codeZh).join('、')}（间隔 ${a.interval}）`
    case 'macro':
      return `宏：${macroPreview(a) || '没有步骤'}（${a.play === 'repeat' ? `播放 ${a.repeat ?? 1} 遍` : PLAY_ZH[a.play]}）`
    case 'raw':
      return '无法识别（原样保留）'
  }
}
/** The F9 reply is ';'-separated, e.g. "84EC(S)Pro BLe;V2.0.4;V2.0;" → "84EC(S)Pro BLe · V2.0.4 · V2.0". */
export function versionLabel(text: string): string {
  const parts = text.split(';').map((p) => p.trim()).filter(Boolean)
  return parts.length ? parts.join(' · ') : text
}

const p2 = (n: number) => String(n).padStart(2, '0')
/** Local time as "2026-10-31 17:22:59" (backups and saved profiles; the browser locale may not be Chinese). */
export function formatSavedAt(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}
