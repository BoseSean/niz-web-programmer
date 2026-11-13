import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { codeById, codeForKeyboardEventCode } from '../../device/codes'
import { FACTORY, KEYS } from '../../device/layout'
import type { CodeInfo } from '../../device/types'
import type { SlotTable } from '../../protocol/slots'
import { isTypingTarget } from './useKeyCapture'

/**
 * Key tester plumbing: records what the computer actually receives from the physical keyboard (and mouse) while the
 * tester is on, maps every key to the device code table and to the physical key(s) that produce it.
 */

export type TesterEventKind = 'down' | 'up' | 'wheel' | 'move' | 'blur'
export type TesterSource = 'key' | 'mouse' | 'window'

export interface ModifierState {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

/** Lock-key state reported by the browser with a key event (the keyboard's LEDs should agree). */
export interface LockState {
  capsLock: boolean
  numLock: boolean
  scrollLock: boolean
}

export interface TesterEvent {
  /** Monotonic number, unique within one recorder (React key). */
  seq: number
  kind: TesterEventKind
  source: TesterSource
  /**
   * KeyboardEvent.code for keys (falls back to KeyboardEvent.key when the code is empty);
   * 'Mouse0'..'Mouse4' for buttons; 'WheelUp' | 'WheelDown' | 'WheelLeft' | 'WheelRight'; 'MouseMove'; 'Blur'.
   */
  code: string
  /** KeyboardEvent.key ('' for non-key events). */
  key: string
  /** Deprecated KeyboardEvent.keyCode, still useful to tell unidentified keys apart (0 for non-key events). */
  keyCode: number
  /** KeyboardEvent.location: 0 standard, 1 left, 2 right, 3 numpad. */
  location: number
  repeat: boolean
  mods: ModifierState
  locks: LockState | null
  /** Event time in ms (Event.timeStamp, same clock for every entry). */
  t: number
  /** Time of the last event merged into this entry (wheel notches / mouse moves are coalesced); equals `t` otherwise. */
  end: number
  /** ms since the previous entry ended (null for the first entry). */
  dt: number | null
  /** For 'up': ms since the matching (first, non-repeat) 'down'; null when the down was not seen. */
  holdMs: number | null
  /** The device code this input corresponds to, when there is one. */
  info: CodeInfo | null
  /** Physical keys whose base-layer action is exactly this code (for highlighting the keyboard view). */
  keyIds: string[]
  /** Display name. */
  zh: string
  en: string
  /** True when the tester called preventDefault() on it. */
  blocked: boolean
  /** Number of browser events merged into this entry (wheel notches, mouse moves); 1 otherwise. */
  count: number
  /** Summed movement / wheel deltas (0 for keys). */
  dx: number
  dy: number
}

export interface HeldKey {
  code: string
  key: string
  zh: string
  en: string
  info: CodeInfo | null
  keyIds: string[]
  source: 'key' | 'mouse'
  /** Time of the first keydown / mousedown. */
  since: number
  /** Auto-repeat keydowns received while held. */
  repeats: number
  /** Interval of the most recent auto-repeat (ms), null before the first repeat. */
  repeatMs: number | null
}

export interface TesterCounts {
  down: number
  up: number
  repeat: number
  mouse: number
  wheel: number
  blocked: number
}

export interface TesterSnapshot {
  /** Bounded log, oldest first. */
  events: readonly TesterEvent[]
  /** Keys / mouse buttons currently held, in press order. */
  held: readonly HeldKey[]
  /** Union of the physical key ids of the held entries. */
  heldKeyIds: readonly string[]
  /** The most recent press (key/mouse 'down', not auto-repeat, or a wheel entry); survives the release. */
  last: TesterEvent | null
  counts: TesterCounts
}

export const DEFAULT_LOG_LIMIT = 300
/** Wheel events in the same direction closer than this are one entry (a trackpad fires dozens per gesture). */
export const WHEEL_MERGE_MS = 80
/** Mouse moves closer than this are one entry. */
export const MOVE_MERGE_MS = 150

// --------------------------------------------------------------------------------------------------------------------
// Code / key lookups
// --------------------------------------------------------------------------------------------------------------------

const keyIdCache = new WeakMap<SlotTable, Map<number, string[]>>()

/**
 * Physical key ids whose base-layer slot is exactly the single code `value` (e.g. 4 = KeyA → ['a']).
 * Defaults to the factory map; pass the keyboard's current table to follow a remapped layout.
 */
export function keyIdsForCode(value: number, table: SlotTable = FACTORY): string[] {
  let map = keyIdCache.get(table)
  if (!map) {
    map = new Map()
    table.base.forEach((slot, i) => {
      if (slot.kind !== 'codes' || slot.codes.length !== 1) return
      const id = KEYS[i]?.id
      if (!id) return
      const list = map!.get(slot.codes[0]) ?? []
      list.push(id)
      map!.set(slot.codes[0], list)
    })
    keyIdCache.set(table, map)
  }
  return [...(map.get(value) ?? [])]
}

/** Device code for a key event: by KeyboardEvent.code, then by KeyboardEvent.key (media keys sometimes have no code). */
export function codeInfoForKey(code: string, key = ''): CodeInfo | undefined {
  return (code ? codeForKeyboardEventCode(code) : undefined) ?? (key && key !== 'Unidentified' ? codeForKeyboardEventCode(key) : undefined)
}

const MOUSE_BUTTONS: Record<number, { zh: string; en: string; id?: string }> = {
  0: { zh: '鼠标左键', en: 'Left button', id: 'MouseLeft' },
  1: { zh: '鼠标中键', en: 'Middle button', id: 'MouseMiddle' },
  2: { zh: '鼠标右键', en: 'Right button', id: 'MouseRight' },
  3: { zh: '鼠标后退键', en: 'Back button' },
  4: { zh: '鼠标前进键', en: 'Forward button' },
}

/** Name and device code of a MouseEvent.button. */
export function mouseButtonInfo(button: number): { code: string; zh: string; en: string; info: CodeInfo | null } {
  const b = MOUSE_BUTTONS[button]
  if (!b) return { code: `Mouse${button}`, zh: `鼠标按键 ${button}`, en: `Mouse button ${button}`, info: null }
  return { code: `Mouse${button}`, zh: b.zh, en: b.en, info: (b.id && codeById(b.id)) || null }
}

const WHEEL: Record<string, { zh: string; en: string; id?: string }> = {
  WheelUp: { zh: '滚轮向上', en: 'Wheel up', id: 'MouseWheelUp' },
  WheelDown: { zh: '滚轮向下', en: 'Wheel down', id: 'MouseWheelDown' },
  WheelLeft: { zh: '滚轮向左', en: 'Wheel left' },
  WheelRight: { zh: '滚轮向右', en: 'Wheel right' },
}

/** Direction code of a wheel event ('WheelUp' | 'WheelDown' | 'WheelLeft' | 'WheelRight'), null when it has no delta. */
export function wheelDirection(deltaX: number, deltaY: number): string | null {
  if (deltaY === 0 && deltaX === 0) return null
  if (Math.abs(deltaY) >= Math.abs(deltaX)) return deltaY < 0 ? 'WheelUp' : 'WheelDown'
  return deltaX < 0 ? 'WheelLeft' : 'WheelRight'
}

const LOCATION_ZH = ['', '左', '右', '小键盘']

function keyNames(code: string, key: string, keyCode: number, info: CodeInfo | undefined, location: number) {
  if (info) return { zh: info.zh, en: info.en }
  const side = LOCATION_ZH[location] ?? ''
  if (code) return { zh: `${side}${code}（代码表里没有）`, en: code }
  if (key && key !== 'Unidentified') return { zh: `${key}（无物理代码）`, en: key }
  return { zh: `未识别的按键（keyCode ${keyCode}）`, en: `Unidentified key (keyCode ${keyCode})` }
}

/** Interval label for the timeline: "+12 ms", "+1.24 s", "+3 min", "—" for none. */
export function formatInterval(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `+${Math.round(ms)} ms`
  if (ms < 60_000) return `+${(ms / 1000).toFixed(2)} s`
  return `+${Math.floor(ms / 60_000)} min`
}

// --------------------------------------------------------------------------------------------------------------------
// preventDefault policy
// --------------------------------------------------------------------------------------------------------------------

/** With Ctrl/⌘ (and no Shift): browser features that would pop up or change the page, safe to suppress. */
const CTRL_BLOCK = new Set([
  'KeyA', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyO', 'KeyP', 'KeyS', 'KeyU', 'KeyY', 'KeyZ',
  'Equal', 'Minus', 'Digit0', 'NumpadAdd', 'NumpadSubtract', 'Numpad0', 'F5', 'Enter', 'Space',
])
/** With Ctrl/⌘+Shift: only redo (it would undo/redo the editor behind the tester). */
const CTRL_SHIFT_BLOCK = new Set(['KeyZ'])
/** With Alt: everything except these (Alt+F4 closes the window, Alt+Tab / Alt+Esc / Alt+Space belong to the OS). */
const ALT_PASS = new Set(['F4', 'Tab', 'Escape', 'Space'])
/** Without modifiers: everything except these. Tab keeps keyboard focus navigation working, F12 opens DevTools. */
const PLAIN_PASS = new Set(['Tab', 'F12'])

const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="checkbox"], [role="switch"], [contenteditable=""], [contenteditable="true"]'

function isInteractive(t: EventTarget | null): boolean {
  return typeof Element !== 'undefined' && t instanceof Element && t.closest(INTERACTIVE) !== null
}

/**
 * Whether the tester suppresses the browser's default action for this key event. It blocks what would scroll,
 * navigate, reload, open find / print / save / zoom or the menu bar, and the editor's own Ctrl+Z / Ctrl+Y; it never
 * blocks closing or switching tabs and windows (Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab, Ctrl+1..9, Alt+F4, Alt+Tab, Win)
 * nor Tab / F12. Enter and Space still activate a focused button or link so the panel stays keyboard-operable.
 */
export function shouldBlockKey(e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'target'>): boolean {
  const code = e.code || e.key
  // AltGr arrives as Ctrl+Alt on Windows; treat it like a plain key so international layouts are not hampered.
  const altGr = e.ctrlKey && e.altKey && !e.metaKey
  if ((e.ctrlKey || e.metaKey) && !altGr) {
    if (code === 'ControlLeft' || code === 'ControlRight' || code === 'MetaLeft' || code === 'MetaRight') return false
    return e.shiftKey ? CTRL_SHIFT_BLOCK.has(code) : CTRL_BLOCK.has(code)
  }
  if (e.altKey && !altGr) return !ALT_PASS.has(code)
  if (PLAIN_PASS.has(code)) return false
  if ((code === 'Enter' || code === 'NumpadEnter' || code === 'Space') && isInteractive(e.target)) return false
  return true
}

/** Mouse buttons whose default is suppressed: middle (autoscroll / paste on Linux), back and forward (history). */
export function shouldBlockMouse(button: number): boolean {
  return button === 1 || button === 3 || button === 4
}

// --------------------------------------------------------------------------------------------------------------------
// Recorder (framework-free, testable with explicit times)
// --------------------------------------------------------------------------------------------------------------------

export interface KeyLike extends ModifierLike {
  code: string
  key: string
  keyCode?: number
  location?: number
  repeat?: boolean
  getModifierState?: (key: string) => boolean
}

export interface RecorderOptions {
  limit?: number
  /** Table whose base layer maps codes to physical keys (default FACTORY). */
  table?: SlotTable
}

/** Modifier flags of any DOM input event. */
export interface ModifierLike {
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}

const ZERO_COUNTS: TesterCounts = { down: 0, up: 0, repeat: 0, mouse: 0, wheel: 0, blocked: 0 }

function modsOf(e: ModifierLike): ModifierState {
  return { ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey, meta: !!e.metaKey }
}

function locksOf(e: KeyLike): LockState | null {
  if (typeof e.getModifierState !== 'function') return null
  try {
    return { capsLock: e.getModifierState('CapsLock'), numLock: e.getModifierState('NumLock'), scrollLock: e.getModifierState('ScrollLock') }
  } catch {
    return null
  }
}

export class KeyEventRecorder {
  private events: TesterEvent[] = []
  private held = new Map<string, HeldKey>()
  private counts: TesterCounts = { ...ZERO_COUNTS }
  private last: TesterEvent | null = null
  private seq = 0
  /** Time of the latest keydown per code (for auto-repeat intervals). */
  private lastDownAt = new Map<string, number>()
  private snap: TesterSnapshot | null = null
  private listeners = new Set<() => void>()
  private limit: number
  private table: SlotTable

  constructor(options: RecorderOptions = {}) {
    this.limit = Math.max(1, options.limit ?? DEFAULT_LOG_LIMIT)
    this.table = options.table ?? FACTORY
  }

  setOptions(options: RecorderOptions): void {
    if (options.table) this.table = options.table
    if (options.limit) {
      this.limit = Math.max(1, options.limit)
      if (this.events.length > this.limit) {
        this.events = this.events.slice(-this.limit)
        this.changed()
      }
    }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): TesterSnapshot => {
    if (!this.snap) {
      const held = [...this.held.values()]
      this.snap = Object.freeze({
        events: Object.freeze([...this.events]),
        held: Object.freeze(held),
        heldKeyIds: Object.freeze([...new Set(held.flatMap((h) => h.keyIds))]),
        last: this.last,
        counts: { ...this.counts },
      })
    }
    return this.snap
  }

  clear(): void {
    this.events = []
    this.held.clear()
    this.counts = { ...ZERO_COUNTS }
    this.last = null
    this.changed()
  }

  keyDown(e: KeyLike, t: number, blocked = false): TesterEvent {
    const code = e.code || e.key || 'Unidentified'
    const entry = this.keyEntry('down', e, t, blocked)
    const h = this.held.get(code)
    if (h) {
      // Auto-repeat (or a second down without an up, e.g. after a lost keyup).
      const prev = this.lastDownAt.get(code) ?? h.since
      this.held.set(code, { ...h, repeats: h.repeats + 1, repeatMs: t - prev })
    } else {
      this.held.set(code, { code, key: e.key, zh: entry.zh, en: entry.en, info: entry.info, keyIds: entry.keyIds, source: 'key', since: t, repeats: 0, repeatMs: null })
    }
    this.lastDownAt.set(code, t)
    if (entry.repeat) this.counts.repeat++
    else {
      this.counts.down++
      this.last = entry
    }
    return this.push(entry)
  }

  keyUp(e: KeyLike, t: number, blocked = false): TesterEvent {
    const code = e.code || e.key || 'Unidentified'
    const h = this.held.get(code)
    const entry = { ...this.keyEntry('up', e, t, blocked), holdMs: h ? t - h.since : null }
    this.held.delete(code)
    this.lastDownAt.delete(code)
    this.counts.up++
    return this.push(entry)
  }

  mouseDown(button: number, e: ModifierLike, t: number, blocked = false): TesterEvent {
    const entry = this.mouseEntry('down', button, e, t, blocked)
    if (!this.held.has(entry.code))
      this.held.set(entry.code, { code: entry.code, key: '', zh: entry.zh, en: entry.en, info: entry.info, keyIds: entry.keyIds, source: 'mouse', since: t, repeats: 0, repeatMs: null })
    this.counts.mouse++
    this.last = entry
    return this.push(entry)
  }

  mouseUp(button: number, e: ModifierLike, t: number, blocked = false): TesterEvent {
    const code = `Mouse${button}`
    const h = this.held.get(code)
    const entry = { ...this.mouseEntry('up', button, e, t, blocked), holdMs: h ? t - h.since : null }
    this.held.delete(code)
    return this.push(entry)
  }

  wheel(deltaX: number, deltaY: number, e: ModifierLike, t: number): TesterEvent | null {
    const code = wheelDirection(deltaX, deltaY)
    if (!code) return null
    this.counts.wheel++
    const prev = this.events.at(-1)
    if (prev && prev.kind === 'wheel' && prev.code === code && t - prev.end <= WHEEL_MERGE_MS) {
      const merged: TesterEvent = { ...prev, end: t, count: prev.count + 1, dx: prev.dx + deltaX, dy: prev.dy + deltaY }
      this.events[this.events.length - 1] = merged
      if (this.last?.seq === prev.seq) this.last = merged
      this.changed()
      return merged
    }
    const w = WHEEL[code]
    const info = (w.id && codeById(w.id)) || null
    const entry = this.base('wheel', 'mouse', code, t, e, false)
    Object.assign(entry, { info, zh: w.zh, en: w.en, dx: deltaX, dy: deltaY })
    this.last = entry
    return this.push(entry)
  }

  move(dx: number, dy: number, t: number): TesterEvent | null {
    if (dx === 0 && dy === 0) return null
    const prev = this.events.at(-1)
    if (prev && prev.kind === 'move' && t - prev.end <= MOVE_MERGE_MS) {
      const merged: TesterEvent = { ...prev, end: t, count: prev.count + 1, dx: prev.dx + dx, dy: prev.dy + dy }
      this.events[this.events.length - 1] = merged
      this.changed()
      return merged
    }
    const entry = this.base('move', 'mouse', 'MouseMove', t, {}, false)
    Object.assign(entry, { zh: '鼠标移动', en: 'Mouse move', dx, dy })
    return this.push(entry)
  }

  /** The window lost focus: the browser will not deliver the releases, so held keys are forgotten. */
  blur(t: number): TesterEvent {
    const entry = this.base('blur', 'window', 'Blur', t, {}, false)
    const n = this.held.size
    Object.assign(entry, { zh: n ? `页面失去焦点（${n} 个按住的键已清空）` : '页面失去焦点', en: 'Window lost focus' })
    this.held.clear()
    this.lastDownAt.clear()
    return this.push(entry)
  }

  /** Forgets held keys without logging (the tester was switched off; releases will not be seen). */
  releaseAll(): void {
    if (!this.held.size) return
    this.held.clear()
    this.lastDownAt.clear()
    this.changed()
  }

  // --- internals ---------------------------------------------------------------------------------------------------
  private base(kind: TesterEventKind, source: TesterSource, code: string, t: number, mods: ModifierLike, blocked: boolean): TesterEvent {
    const prev = this.events.at(-1)
    return {
      seq: ++this.seq,
      kind,
      source,
      code,
      key: '',
      keyCode: 0,
      location: 0,
      repeat: false,
      mods: modsOf(mods),
      locks: null,
      t,
      end: t,
      dt: prev ? Math.max(0, t - prev.end) : null,
      holdMs: null,
      info: null,
      keyIds: [],
      zh: code,
      en: code,
      blocked,
      count: 1,
      dx: 0,
      dy: 0,
    }
  }

  private keyEntry(kind: 'down' | 'up', e: KeyLike, t: number, blocked: boolean): TesterEvent {
    const code = e.code || e.key || 'Unidentified'
    const info = codeInfoForKey(e.code, e.key) ?? null
    const location = e.location ?? 0
    const keyCode = e.keyCode ?? 0
    const entry = this.base(kind, 'key', code, t, e, blocked)
    return {
      ...entry,
      key: e.key,
      keyCode,
      location,
      repeat: kind === 'down' && !!e.repeat,
      locks: locksOf(e),
      info,
      keyIds: info ? keyIdsForCode(info.value, this.table) : [],
      ...keyNames(e.code, e.key, keyCode, info ?? undefined, location),
    }
  }

  private mouseEntry(kind: 'down' | 'up', button: number, e: ModifierLike, t: number, blocked: boolean): TesterEvent {
    const m = mouseButtonInfo(button)
    const entry = this.base(kind, 'mouse', m.code, t, e, blocked)
    return { ...entry, info: m.info, zh: m.zh, en: m.en, keyIds: m.info ? keyIdsForCode(m.info.value, this.table) : [] }
  }

  private push(entry: TesterEvent): TesterEvent {
    if (entry.blocked) this.counts.blocked++
    this.events.push(entry)
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit)
    this.changed()
    return entry
  }

  private changed(): void {
    this.snap = null
    for (const fn of [...this.listeners]) fn()
  }
}

// --------------------------------------------------------------------------------------------------------------------
// React hook
// --------------------------------------------------------------------------------------------------------------------

export interface PhysicalKeyEventsOptions extends RecorderOptions {
  /** Also log (coalesced) mouse movement, e.g. to see the device's mouse-move codes. Default false. */
  trackMouseMove?: boolean
  /** Event source; default `window`. */
  target?: Window
}

export interface PhysicalKeyEvents extends TesterSnapshot {
  clear: () => void
}

const stamp = (e: Event) => (e.timeStamp > 0 ? e.timeStamp : typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * While `enabled`, records keydown/keyup, mouse buttons, wheel (and optionally movement) on the window, in the capture
 * phase so the editor's own shortcuts never see a key the tester blocked. See shouldBlockKey() for what is blocked.
 * The log survives disabling (it is cleared only by clear()); held keys are dropped when the tester is disabled.
 * Keys typed into a text field are left alone (neither blocked nor recorded).
 */
export function usePhysicalKeyEvents(enabled: boolean, options: PhysicalKeyEventsOptions = {}): PhysicalKeyEvents {
  const { limit, table, trackMouseMove = false, target } = options
  const [recorder] = useState(() => new KeyEventRecorder({ limit, table }))
  useEffect(() => recorder.setOptions({ limit, table }), [recorder, limit, table])
  const snap = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot, recorder.getSnapshot)
  const moveRef = useRef(trackMouseMove)
  useEffect(() => {
    moveRef.current = trackMouseMove
  })

  useEffect(() => {
    if (!enabled) return
    const win = target ?? (typeof window !== 'undefined' ? window : undefined)
    if (!win) return
    // Text typed into a field elsewhere on the page (packet-log filter, a name) is typing, not a test press.
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      const block = shouldBlockKey(e)
      if (block) e.preventDefault()
      recorder.keyDown(e, stamp(e), block)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      const block = shouldBlockKey(e)
      if (block) e.preventDefault()
      recorder.keyUp(e, stamp(e), block)
    }
    const onMouseDown = (e: MouseEvent) => {
      const block = shouldBlockMouse(e.button)
      if (block) e.preventDefault()
      recorder.mouseDown(e.button, e, stamp(e), block)
    }
    const onMouseUp = (e: MouseEvent) => {
      const block = shouldBlockMouse(e.button)
      if (block) e.preventDefault()
      recorder.mouseUp(e.button, e, stamp(e), block)
    }
    const onAux = (e: MouseEvent) => {
      if (shouldBlockMouse(e.button)) e.preventDefault()
    }
    // Right-click / the Menu key would open the context menu over the panel.
    const onContextMenu = (e: Event) => e.preventDefault()
    const onWheel = (e: WheelEvent) => void recorder.wheel(e.deltaX, e.deltaY, e, stamp(e))
    const onMove = (e: MouseEvent) => {
      if (moveRef.current) recorder.move(e.movementX ?? 0, e.movementY ?? 0, stamp(e))
    }
    const onBlur = (e: Event) => void recorder.blur(stamp(e))
    const opts = { capture: true }
    win.addEventListener('keydown', onKeyDown, opts)
    win.addEventListener('keyup', onKeyUp, opts)
    win.addEventListener('mousedown', onMouseDown, opts)
    win.addEventListener('mouseup', onMouseUp, opts)
    win.addEventListener('auxclick', onAux, opts)
    win.addEventListener('contextmenu', onContextMenu, opts)
    win.addEventListener('wheel', onWheel, { capture: true, passive: true })
    win.addEventListener('mousemove', onMove, { capture: true, passive: true })
    win.addEventListener('blur', onBlur)
    return () => {
      win.removeEventListener('keydown', onKeyDown, opts)
      win.removeEventListener('keyup', onKeyUp, opts)
      win.removeEventListener('mousedown', onMouseDown, opts)
      win.removeEventListener('mouseup', onMouseUp, opts)
      win.removeEventListener('auxclick', onAux, opts)
      win.removeEventListener('contextmenu', onContextMenu, opts)
      win.removeEventListener('wheel', onWheel, opts)
      win.removeEventListener('mousemove', onMove, opts)
      win.removeEventListener('blur', onBlur)
      recorder.releaseAll()
    }
  }, [enabled, recorder, target])

  const clear = useMemo(() => () => recorder.clear(), [recorder])
  return useMemo(() => ({ ...snap, clear }), [snap, clear])
}
