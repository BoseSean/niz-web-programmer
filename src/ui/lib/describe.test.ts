import { describe, expect, it } from 'vitest'
import { codeById, codeByValue } from '../../device/codes'
import { keyById } from '../../device/layout'
import type { Action } from '../../format/types'
import {
  ACTION_ZH,
  actionFace,
  CATEGORY_ZH,
  describeAction,
  isNoEffect,
  isUncertain,
  isUnverified,
  macroDurationMs,
  macroPreview,
  noteZh,
  PLAY_ZH,
} from './describe'

type Macro = Extract<Action, { type: 'macro' }>
const macro = (steps: Macro['steps'], extra: Partial<Macro> = {}): Macro => ({ type: 'macro', play: 'repeat', repeat: 1, steps, ...extra })

describe('macroPreview', () => {
  it('reads keys pressed together as a chord and waits as pauses', () => {
    const copyPaste = macro([{ down: 'ControlLeft' }, { tap: 'KeyC' }, { up: 'ControlLeft' }, { wait: 100 }, { tap: 'KeyV' }])
    expect(macroPreview(copyPaste)).toBe('Ctrl+C → 停 100 ms → V')
  })

  it('reads a recorded chord (hold times inside it are left out) and skips 0 ms waits', () => {
    const recorded = macro([
      { down: 'ControlLeft' }, { wait: 25 }, { down: 'KeyC' }, { wait: 60 }, { up: 'KeyC' }, { wait: 5 }, { up: 'ControlLeft' },
      { wait: 0 }, { down: 'KeyV' }, { wait: 40 }, { up: 'KeyV' },
    ])
    expect(macroPreview(recorded)).toBe('Ctrl+C → V')
  })

  it('says 按住 / 松开 for presses and releases that are not a chord', () => {
    const shifted = macro([{ down: 'ShiftLeft' }, { tap: 'KeyA' }, { tap: 'KeyB' }, { up: 'ShiftLeft' }])
    expect(macroPreview(shifted)).toBe('按住 Shift → A → B → 松开 Shift')
    expect(macroPreview(macro([{ up: 'KeyA' }]))).toBe('松开 A')
  })

  it('cuts off after max items', () => {
    const many = macro(['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE'].map((tap) => ({ tap })))
    expect(macroPreview(many)).toBe('A → B → C → D → …')
    expect(macroPreview(many, 8)).toBe('A → B → C → D → E')
    expect(macroPreview(macro([]))).toBe('')
  })
})

describe('macroDurationMs', () => {
  it('counts every gap between events with a fixed interval, including inside a tap', () => {
    expect(macroDurationMs(macro([{ tap: 'KeyA' }, { tap: 'KeyB' }], { interval: 30 }))).toBe(90)
    expect(macroDurationMs(macro([], { interval: 30 }))).toBe(0)
  })

  it('adds the waits between events with step timing, ignoring waits before the first and after the last', () => {
    expect(macroDurationMs(macro([{ wait: 500 }, { tap: 'KeyA' }, { wait: 100 }, { down: 'KeyB' }, { wait: 20 }, { wait: 5 }, { up: 'KeyB' }, { wait: 900 }]))).toBe(125)
  })
})

describe('describeAction and actionFace', () => {
  const k = keyById('f1')!

  it('uses one name per concept', () => {
    expect(ACTION_ZH.emulate).toBe('连发')
    expect(ACTION_ZH.raw).toBe('无法识别')
    expect(CATEGORY_ZH.function).toBe('键盘功能')
    expect(CATEGORY_ZH.special).toBe('未知功能')
    expect(PLAY_ZH).toEqual({ repeat: '按一下播放', hold: '按住时播放', toggle: '按一下开/关' })
  })

  it('describes what a macro types and how it plays', () => {
    const steps: Macro['steps'] = [{ down: 'ControlLeft' }, { tap: 'KeyC' }, { up: 'ControlLeft' }]
    expect(describeAction(macro(steps, { repeat: 3, interval: 30 }))).toBe('宏：Ctrl+C（播放 3 遍）')
    expect(describeAction({ type: 'macro', play: 'hold', steps })).toBe('宏：Ctrl+C（按住时播放）')
    expect(describeAction({ type: 'macro', play: 'toggle', interval: 30, steps: [] })).toBe('宏：没有步骤（按一下开/关）')
  })

  it('describes emulates as 连发 and raw slots as 无法识别', () => {
    expect(describeAction({ type: 'emulate', keys: ['KeyZ', 'KeyX'], interval: 30 })).toBe('连发 Z、X（间隔 30）')
    expect(describeAction({ type: 'raw', packets: ['00F0'] })).toBe('无法识别（原样保留）')
  })

  it('labels caps the same way', () => {
    expect(actionFace({ type: 'emulate', keys: ['KeyZ'], interval: 30 }, k)).toEqual({ main: 'Z', legend: 'F1', tag: '连发' })
    expect(actionFace({ type: 'emulate', keys: [], interval: 30 }, k).main).toBe('连发')
    expect(actionFace({ type: 'raw', packets: [] }, k)).toEqual({ main: '?', legend: 'F1', tag: '未识别' })
    expect(actionFace({ type: 'key', code: 'DeviceA2' }, k).tag).toBe('未知')
    expect(actionFace({ type: 'key', code: 222 }, k).tag).toBe('未知')
  })
})

describe('code certainty', () => {
  it('separates codes that do nothing from codes whose effect is not verified', () => {
    expect(isNoEffect(codeById('BacklightToggle'))).toBe(true)
    expect(isUnverified(codeById('BacklightToggle'))).toBe(false)
    expect(isUnverified(codeById('BacklightUp'))).toBe(true)
    expect(isUnverified(codeById('DeviceA2'))).toBe(true)
    expect(isUnverified(codeById('ScanDelay'))).toBe(true)
    expect(isUnverified(undefined)).toBe(true)
    expect(isUncertain(codeById('BacklightToggle'))).toBe(true)
  })

  it('does not doubt codes the manual documents or plain keys', () => {
    // NumberRowLock is not offered by KB84, but the 84EC-S manual documents it (Fn+Esc locks the number row).
    const rowLock = codeByValue(151)
    expect(rowLock?.pickable).toBe(false)
    expect(isNoEffect(rowLock) || isUnverified(rowLock) || isUncertain(rowLock)).toBe(false)
    expect(isUncertain(codeById('KeyA'))).toBe(false)
    expect(isUncertain(codeById('KeyboardLock'))).toBe(false)
  })

  it('names the mode switch with the glossary terms', () => {
    expect(noteZh(codeById('ProgramMode')!.note)).toBe('按住约 2 秒切换办公模式（出厂键位）/ 编程模式（你写入的键位）；编程模式下 M 灯亮')
    expect(noteZh(codeById('DeviceA2')!.note)).toBe('未知功能，原样保留（出厂位于 Fn+G）')
  })
})
