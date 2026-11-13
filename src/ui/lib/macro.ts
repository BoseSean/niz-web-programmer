import { resolveCodeRef } from '../../device/codes'
import { MACRO_MAX_DATA_BYTES, macroDataLength } from '../../format/compile'
import type { CodeRef, MacroStep } from '../../format/types'
import { DELAY_MARKER } from '../../protocol/codec'
import { macroEventCount, stepCode } from './describe'

const MAX_WAIT = 65535

/** A code reference as a comparable key ("KeyA" and 43 are the same code). */
const codeKey = (ref: CodeRef) => String(resolveCodeRef(ref)?.value ?? ref)

export interface RecordedEvent {
  ref: CodeRef
  dir: 'down' | 'up'
  t: number
}

/** Recorded key events -> macro steps. Without timing, a press directly followed by its release becomes a tap. */
export function recordedSteps(events: readonly RecordedEvent[], withTiming: boolean): MacroStep[] {
  const steps: MacroStep[] = []
  events.forEach((ev, i) => {
    if (withTiming && i > 0) steps.push({ wait: Math.min(MAX_WAIT, Math.max(0, Math.round(ev.t - events[i - 1].t))) })
    const prev = steps.at(-1)
    if (!withTiming && ev.dir === 'up' && prev && 'down' in prev && prev.down === ev.ref) steps[steps.length - 1] = { tap: ev.ref }
    else steps.push(ev.dir === 'down' ? { down: ev.ref } : { up: ev.ref })
  })
  return steps
}

/**
 * Why a fixed-interval macro cannot switch to step timing (Chinese, for an inline note), or null when it can. Step
 * timing stores a delay before every event after the first (len = 4 × events − 3, docs/FORMAT.md §7.6), so a long
 * macro would outgrow the keyboard; code 200 is the delay marker itself (§7.2).
 */
export function stepTimingProblem(steps: readonly MacroStep[]): string | null {
  if (macroDataLength(macroEventCount(steps), true) > MACRO_MAX_DATA_BYTES)
    return '这个宏太长，改成逐步设置会超出容量（最多约 400 个按键事件）'
  if (steps.some((s) => !('wait' in s) && resolveCodeRef(stepCode(s))?.value === DELAY_MARKER))
    return '这个宏里有代码 200（延时标记），不能改成逐步设置'
  return null
}

/**
 * Fixed interval -> step timing with the same playback. The keyboard waits `interval` between every two events,
 * including the press and release of one tap (docs/FORMAT.md §7.2), so each tap becomes press, wait, release and
 * every gap between events gets an explicit wait. Waits already in the list (not played with a fixed interval) are
 * dropped. Check stepTimingProblem first.
 */
export function toStepTiming(steps: readonly MacroStep[], interval: number): MacroStep[] {
  const out: MacroStep[] = []
  const push = (s: MacroStep) => {
    if (out.length && interval > 0) out.push({ wait: interval })
    out.push(s)
  }
  for (const s of steps) {
    if ('wait' in s) continue
    if ('tap' in s && interval > 0) {
      push({ down: s.tap })
      push({ up: s.tap })
    } else push(s)
  }
  return out
}

/**
 * Step timing -> fixed interval: drops the waits and turns a press directly followed by its release back into a tap
 * (the same two events), so toStepTiming followed by toFixedTiming gives the original steps.
 */
export function toFixedTiming(steps: readonly MacroStep[]): MacroStep[] {
  const out: MacroStep[] = []
  for (const s of steps) {
    if ('wait' in s) continue
    const prev = out.at(-1)
    if ('up' in s && prev && 'down' in prev && codeKey(prev.down) === codeKey(s.up)) out[out.length - 1] = { tap: prev.down }
    else out.push(s)
  }
  return out
}
