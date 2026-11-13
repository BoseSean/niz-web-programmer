// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { codeById } from '../../device/codes'
import { factoryTable } from '../../device/layout'
import {
  DEFAULT_LOG_LIMIT,
  formatInterval,
  KeyEventRecorder,
  keyIdsForCode,
  shouldBlockKey,
  usePhysicalKeyEvents,
  wheelDirection,
} from './keyEvents'

const hooks: { unmount: () => void }[] = []
afterEach(() => {
  while (hooks.length) hooks.pop()!.unmount()
})

function setup(enabled = true, options: Parameters<typeof usePhysicalKeyEvents>[1] = {}) {
  const h = renderHook(({ on }) => usePhysicalKeyEvents(on, options), { initialProps: { on: enabled } })
  hooks.push(h)
  return h
}

/** Dispatches a key event on window and returns it (to inspect defaultPrevented). */
function key(type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}, target: EventTarget = window): KeyboardEvent {
  const e = new KeyboardEvent(type, { code, key: init.key ?? code, bubbles: true, cancelable: true, ...init })
  act(() => void target.dispatchEvent(e))
  return e
}

function mouse(type: 'mousedown' | 'mouseup', button: number): MouseEvent {
  const e = new MouseEvent(type, { button, bubbles: true, cancelable: true })
  act(() => void window.dispatchEvent(e))
  return e
}

function wheel(deltaY: number, deltaX = 0) {
  act(() => void window.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaX, bubbles: true })))
}

const val = (id: string) => codeById(id)!.value

describe('keyIdsForCode', () => {
  it('finds the physical key whose factory base action is the code', () => {
    expect(keyIdsForCode(val('KeyA'))).toEqual(['a'])
    expect(keyIdsForCode(val('CapsLock'))).toEqual(['caps'])
    expect(keyIdsForCode(val('ControlRight'))).toEqual(['rctrl'])
    expect(keyIdsForCode(val('ShiftLeft'))).toEqual(['lshift'])
    expect(keyIdsForCode(val('MouseLeft'))).toEqual([])
    expect(keyIdsForCode(0xa2)).toEqual([])
  })

  it('follows a remapped table', () => {
    const t = factoryTable()
    t.base[46] = { kind: 'codes', codes: [val('ControlLeft')] } // Caps Lock key → Ctrl
    expect(keyIdsForCode(val('ControlLeft'), t).sort()).toEqual(['caps', 'lctrl'])
    expect(keyIdsForCode(val('CapsLock'), t)).toEqual([])
  })

  it('returns a copy callers may mutate', () => {
    keyIdsForCode(val('KeyA')).push('x')
    expect(keyIdsForCode(val('KeyA'))).toEqual(['a'])
  })
})

describe('usePhysicalKeyEvents', () => {
  it('records down/up, held keys and highlight ids', () => {
    const { result } = setup()
    key('keydown', 'KeyA', { key: 'a' })
    expect(result.current.held.map((h) => h.code)).toEqual(['KeyA'])
    expect(result.current.heldKeyIds).toEqual(['a'])
    expect(result.current.last).toMatchObject({ kind: 'down', code: 'KeyA', key: 'a', zh: 'A', keyIds: ['a'] })
    expect(result.current.last!.info!.value).toBe(val('KeyA'))

    key('keydown', 'CapsLock', { key: 'CapsLock' })
    key('keydown', 'ControlRight', { key: 'Control', location: 2, ctrlKey: true })
    expect([...result.current.heldKeyIds].sort()).toEqual(['a', 'caps', 'rctrl'])
    expect(result.current.last).toMatchObject({ code: 'ControlRight', location: 2 })
    expect(result.current.last!.mods.ctrl).toBe(true)

    key('keyup', 'KeyA', { key: 'a' })
    key('keyup', 'CapsLock')
    key('keyup', 'ControlRight', { key: 'Control', location: 2 })
    expect(result.current.held).toEqual([])
    expect(result.current.events.map((e) => `${e.kind}:${e.code}`)).toEqual([
      'down:KeyA', 'down:CapsLock', 'down:ControlRight', 'up:KeyA', 'up:CapsLock', 'up:ControlRight',
    ])
    expect(result.current.events[3].holdMs).not.toBeNull()
    expect(result.current.counts).toMatchObject({ down: 3, up: 3, repeat: 0 })
    // `last` survives the release
    expect(result.current.last!.code).toBe('ControlRight')
  })

  it('counts auto-repeat separately and keeps the key held once', () => {
    const { result } = setup()
    key('keydown', 'KeyJ', { key: 'j' })
    key('keydown', 'KeyJ', { key: 'j', repeat: true })
    key('keydown', 'KeyJ', { key: 'j', repeat: true })
    expect(result.current.held).toHaveLength(1)
    expect(result.current.held[0].repeats).toBe(2)
    expect(result.current.counts).toMatchObject({ down: 1, repeat: 2 })
    expect(result.current.last!.repeat).toBe(false)
  })

  it('keeps a bounded log', () => {
    const { result } = setup()
    for (let i = 0; i < 200; i++) {
      key('keydown', 'KeyB', { key: 'b' })
      key('keyup', 'KeyB', { key: 'b' })
    }
    expect(result.current.events).toHaveLength(DEFAULT_LOG_LIMIT)
    expect(result.current.events[0].seq).toBe(400 - DEFAULT_LOG_LIMIT + 1)
    expect(result.current.counts.down).toBe(200)
  })

  it('honours a custom limit', () => {
    const { result } = setup(true, { limit: 5 })
    for (let i = 0; i < 9; i++) key('keydown', 'KeyC', { key: 'c', repeat: i > 0 })
    expect(result.current.events).toHaveLength(5)
  })

  it('records mouse buttons and wheel with names and device codes', () => {
    const { result } = setup()
    const left = mouse('mousedown', 0)
    expect(left.defaultPrevented).toBe(false)
    expect(result.current.last).toMatchObject({ kind: 'down', zh: '鼠标左键', code: 'Mouse0' })
    expect(result.current.last!.info!.id).toBe('MouseLeft')
    expect(result.current.held.map((h) => h.zh)).toEqual(['鼠标左键'])
    mouse('mouseup', 0)
    expect(result.current.held).toEqual([])

    mouse('mousedown', 2)
    expect(result.current.last!.zh).toBe('鼠标右键')
    mouse('mouseup', 2)
    const middle = mouse('mousedown', 1)
    expect(middle.defaultPrevented).toBe(true) // no autoscroll
    expect(result.current.last!.zh).toBe('鼠标中键')
    mouse('mouseup', 1)
    expect(mouse('mousedown', 3).defaultPrevented).toBe(true) // back button would navigate
    mouse('mouseup', 3)

    wheel(-100)
    expect(result.current.last).toMatchObject({ kind: 'wheel', zh: '滚轮向上', code: 'WheelUp' })
    expect(result.current.last!.info!.id).toBe('MouseWheelUp')
    wheel(100)
    expect(result.current.last!.zh).toBe('滚轮向下')
    expect(result.current.counts.mouse).toBe(4)
    expect(result.current.counts.wheel).toBe(2)
  })

  it('suppresses scrolling / navigation keys but never tab, window or app-switch shortcuts', () => {
    setup()
    expect(key('keydown', 'Space', { key: ' ' }).defaultPrevented).toBe(true)
    expect(key('keydown', 'ArrowDown').defaultPrevented).toBe(true)
    expect(key('keydown', 'PageDown').defaultPrevented).toBe(true)
    expect(key('keydown', 'Backspace').defaultPrevented).toBe(true)
    expect(key('keydown', 'F5').defaultPrevented).toBe(true)
    expect(key('keydown', 'KeyF', { key: 'f', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(key('keydown', 'KeyZ', { key: 'z', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(key('keydown', 'ArrowLeft', { altKey: true }).defaultPrevented).toBe(true)

    expect(key('keydown', 'KeyW', { key: 'w', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(key('keydown', 'KeyT', { key: 't', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(key('keydown', 'Tab', { key: 'Tab', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(key('keydown', 'Digit1', { key: '1', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(key('keydown', 'F4', { altKey: true }).defaultPrevented).toBe(false)
    expect(key('keydown', 'Tab').defaultPrevented).toBe(false)
    expect(key('keydown', 'F12').defaultPrevented).toBe(false)
  })

  it('lets Enter / Space activate a focused button', () => {
    const { result } = setup()
    const btn = document.createElement('button')
    document.body.append(btn)
    try {
      expect(key('keydown', 'Space', { key: ' ' }, btn).defaultPrevented).toBe(false)
      expect(key('keydown', 'Enter', { key: 'Enter' }, btn).defaultPrevented).toBe(false)
      expect(result.current.events.map((e) => e.code)).toEqual(['Space', 'Enter'])
    } finally {
      btn.remove()
    }
  })

  it('blocks keys before the editor shortcuts see them (capture phase)', () => {
    setup()
    let seen: boolean | null = null
    const appShortcut = (e: KeyboardEvent) => void (seen = e.defaultPrevented)
    window.addEventListener('keydown', appShortcut)
    try {
      key('keydown', 'Digit2', { key: '2' })
      expect(seen).toBe(true)
    } finally {
      window.removeEventListener('keydown', appShortcut)
    }
  })

  it('maps media keys by key when the code is empty', () => {
    const { result } = setup()
    key('keydown', '', { key: 'AudioVolumeUp' })
    expect(result.current.last!.info!.id).toBe('AudioVolumeUp')
    expect(result.current.last!.zh).toBe('音量+')
    key('keydown', 'MediaPlayPause', { key: 'MediaPlayPause' })
    expect(result.current.last!.info!.id).toBe('MediaPlayPause')
  })

  it('names keys the code table does not have', () => {
    const { result } = setup()
    key('keydown', 'IntlBackslash', { key: '\\' })
    expect(result.current.last).toMatchObject({ info: null, keyIds: [] })
    expect(result.current.last!.zh).toContain('IntlBackslash')
    key('keydown', '', { key: 'Unidentified', keyCode: 255 } as KeyboardEventInit)
    expect(result.current.last!.zh).toContain('未识别')
  })

  it('forgets held keys when the window loses focus', () => {
    const { result } = setup()
    key('keydown', 'MetaLeft', { key: 'Meta' })
    act(() => void window.dispatchEvent(new FocusEvent('blur')))
    expect(result.current.held).toEqual([])
    expect(result.current.events.at(-1)!.kind).toBe('blur')
  })

  it('records nothing while disabled and releases held keys when switched off', () => {
    const { result, rerender } = setup(false)
    expect(key('keydown', 'Space', { key: ' ' }).defaultPrevented).toBe(false)
    expect(result.current.events).toEqual([])

    rerender({ on: true })
    key('keydown', 'KeyA', { key: 'a' })
    expect(result.current.held).toHaveLength(1)
    rerender({ on: false })
    expect(result.current.held).toEqual([])
    expect(result.current.events).toHaveLength(1) // the log survives
    act(() => result.current.clear())
    expect(result.current.events).toEqual([])
    expect(result.current.last).toBeNull()
  })
})

describe('KeyEventRecorder timing', () => {
  const k = (code: string, extra: Partial<{ repeat: boolean }> = {}) => ({ code, key: code, ...extra })

  it('reports intervals, hold and repeat rate', () => {
    const r = new KeyEventRecorder()
    r.keyDown(k('KeyA'), 1000)
    r.keyDown(k('KeyA', { repeat: true }), 1500)
    r.keyDown(k('KeyA', { repeat: true }), 1533)
    r.keyUp(k('KeyA'), 1540)
    r.keyDown(k('KeyB'), 1570)
    const s = r.getSnapshot()
    expect(s.events.map((e) => e.dt)).toEqual([null, 500, 33, 7, 30])
    expect(s.events[3].holdMs).toBe(540)
    expect(s.held[0].code).toBe('KeyB')
  })

  it('tracks the repeat interval of the held key', () => {
    const r = new KeyEventRecorder()
    r.keyDown(k('KeyA'), 0)
    r.keyDown(k('KeyA', { repeat: true }), 500)
    r.keyDown(k('KeyA', { repeat: true }), 533)
    expect(r.getSnapshot().held[0]).toMatchObject({ repeats: 2, repeatMs: 33 })
  })

  it('merges a burst of wheel events in one direction', () => {
    const r = new KeyEventRecorder()
    r.wheel(0, -100, {}, 0)
    r.wheel(0, -100, {}, 30)
    r.wheel(0, -100, {}, 60)
    r.wheel(0, 100, {}, 70)
    r.wheel(0, 100, {}, 500)
    const s = r.getSnapshot()
    expect(s.events.map((e) => [e.code, e.count])).toEqual([['WheelUp', 3], ['WheelDown', 1], ['WheelDown', 1]])
    expect(s.events[0].dy).toBe(-300)
    expect(s.counts.wheel).toBe(5)
  })

  it('handles a release without a press (PrtSc on Windows)', () => {
    const r = new KeyEventRecorder()
    const e = r.keyUp(k('PrintScreen'), 10)
    expect(e.holdMs).toBeNull()
    expect(e.keyIds).toEqual(['prtsc'])
  })

  it('returns a stable snapshot until something changes', () => {
    const r = new KeyEventRecorder()
    const a = r.getSnapshot()
    expect(r.getSnapshot()).toBe(a)
    r.keyDown(k('KeyA'), 0)
    expect(r.getSnapshot()).not.toBe(a)
  })
})

describe('helpers', () => {
  it('wheelDirection', () => {
    expect(wheelDirection(0, -1)).toBe('WheelUp')
    expect(wheelDirection(0, 3)).toBe('WheelDown')
    expect(wheelDirection(-5, 1)).toBe('WheelLeft')
    expect(wheelDirection(0, 0)).toBeNull()
  })

  it('formatInterval', () => {
    expect(formatInterval(null)).toBe('—')
    expect(formatInterval(12.4)).toBe('+12 ms')
    expect(formatInterval(1240)).toBe('+1.24 s')
    expect(formatInterval(180_000)).toBe('+3 min')
  })

  it('shouldBlockKey treats AltGr as a plain key', () => {
    const base = { key: '', metaKey: false, shiftKey: false, target: null }
    expect(shouldBlockKey({ ...base, code: 'KeyQ', ctrlKey: true, altKey: true })).toBe(true)
    expect(shouldBlockKey({ ...base, code: 'KeyQ', ctrlKey: true, altKey: false })).toBe(false)
    expect(shouldBlockKey({ ...base, code: 'KeyZ', ctrlKey: true, altKey: false, shiftKey: true })).toBe(true)
    expect(shouldBlockKey({ ...base, code: 'KeyI', ctrlKey: true, altKey: false, shiftKey: true })).toBe(false)
  })
})

describe('typing elsewhere while the tester is on (review regressions)', () => {
  it('leaves keys typed into a text field alone: not blocked, not recorded', () => {
    const { result } = setup()
    const input = document.createElement('input')
    input.type = 'search'
    document.body.append(input)
    try {
      expect(key('keydown', 'KeyA', { key: 'a' }, input).defaultPrevented).toBe(false)
      expect(key('keydown', 'Backspace', { key: 'Backspace' }, input).defaultPrevented).toBe(false)
      expect(key('keydown', 'Space', { key: ' ' }, input).defaultPrevented).toBe(false)
      expect(key('keyup', 'KeyA', { key: 'a' }, input).defaultPrevented).toBe(false)
      expect(result.current.events).toHaveLength(0)
      // A checkbox is not a text field: its keys are still test presses.
      const box = document.createElement('input')
      box.type = 'checkbox'
      document.body.append(box)
      key('keydown', 'KeyB', { key: 'b' }, box)
      expect(result.current.events.map((e) => e.code)).toEqual(['KeyB'])
      box.remove()
    } finally {
      input.remove()
    }
  })
})
