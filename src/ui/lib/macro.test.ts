import { describe, expect, it } from 'vitest'
import { actionToSlot } from '../../format/compile'
import { normalizeActionInput } from '../../format/normalize'
import type { Action, MacroStep } from '../../format/types'
import { decodeSlotPackets, encodeSlot } from '../../protocol/codec'
import { macroDurationMs } from './describe'
import { stepTimingProblem, toFixedTiming, toStepTiming } from './macro'

type Macro = Extract<Action, { type: 'macro' }>

const fixedMacro = (steps: MacroStep[], interval: number): Macro => ({ type: 'macro', play: 'repeat', repeat: 1, interval, steps })
const stepMacro = (steps: MacroStep[]): Macro => ({ type: 'macro', play: 'repeat', repeat: 1, steps })

/** The events and per-gap delays the keyboard plays, read back from the encoded packets. */
function played(a: Macro): { events: number[]; delays: number[] } {
  expect(normalizeActionInput(a).issues.filter((i) => i.severity === 'error')).toEqual([])
  const slot = decodeSlotPackets(encodeSlot(1, 1, actionToSlot(a))).slot
  if (slot.kind !== 'macro') throw new Error(`expected a macro slot, got ${slot.kind}`)
  const gaps = slot.events.length - 1
  return { events: slot.events, delays: slot.hasDelays ? slot.delays : Array.from({ length: gaps }, () => slot.autoDelay) }
}

describe('toStepTiming', () => {
  it('writes the fixed interval out as waits between every two events, including inside a tap', () => {
    const steps: MacroStep[] = [{ tap: 'KeyA' }, { tap: 'KeyB' }]
    expect(toStepTiming(steps, 30)).toEqual([
      { down: 'KeyA' }, { wait: 30 }, { up: 'KeyA' }, { wait: 30 }, { down: 'KeyB' }, { wait: 30 }, { up: 'KeyB' },
    ])
  })

  it('plays exactly like the fixed-interval macro: same events and every delay equal to the interval', () => {
    const steps: MacroStep[] = [{ down: 'ControlLeft' }, { tap: 'KeyC' }, { up: 'ControlLeft' }, { tap: 'KeyV' }]
    const before = fixedMacro(steps, 45)
    const after = stepMacro(toStepTiming(steps, 45))
    const a = played(before)
    const b = played(after)
    expect(b.events).toEqual(a.events)
    expect(b.delays).toHaveLength(a.events.length - 1)
    expect(b.delays.every((d) => d === 45)).toBe(true)
    expect(b.delays).toEqual(a.delays)
    expect(macroDurationMs(after)).toBe(macroDurationMs(before))
  })

  it('needs no waits for a 0 ms interval and drops waits a fixed interval does not play', () => {
    expect(toStepTiming([{ tap: 'KeyA' }, { wait: 500 }, { tap: 'KeyB' }], 0)).toEqual([{ tap: 'KeyA' }, { tap: 'KeyB' }])
    expect(played(stepMacro(toStepTiming([{ tap: 'KeyA' }, { tap: 'KeyB' }], 0))).delays).toEqual([0, 0, 0])
  })
})

describe('stepTimingProblem', () => {
  const taps = (n: number): MacroStep[] => Array.from({ length: n }, (_, i) => ({ tap: i % 2 ? 'KeyA' : 'KeyB' }))

  it('refuses macros that would outgrow the keyboard with step timing (len = 4 × events − 3)', () => {
    expect(stepTimingProblem(taps(200))).toBeNull() // 400 events: len 1597
    expect(stepTimingProblem([...taps(200), { down: 'KeyC' }])).toBe('这个宏太长，改成逐步设置会超出容量（最多约 400 个按键事件）')
  })

  it('refuses code 200, the delay marker of step timing', () => {
    expect(stepTimingProblem([{ tap: 'KeyA' }, { tap: 200 }])).toMatch(/代码 200/)
  })
})

describe('toFixedTiming', () => {
  it('drops the waits and turns a press directly followed by its release back into a tap', () => {
    const steps: MacroStep[] = [{ down: 'ShiftLeft' }, { wait: 20 }, { down: 'KeyA' }, { wait: 60 }, { up: 'KeyA' }, { up: 'ShiftLeft' }]
    expect(toFixedTiming(steps)).toEqual([{ down: 'ShiftLeft' }, { tap: 'KeyA' }, { up: 'ShiftLeft' }])
  })

  it('undoes toStepTiming', () => {
    const steps: MacroStep[] = [{ down: 'ControlLeft' }, { tap: 'KeyC' }, { up: 'ControlLeft' }, { tap: 'KeyV' }]
    expect(toFixedTiming(toStepTiming(steps, 30))).toEqual(steps)
  })
})
