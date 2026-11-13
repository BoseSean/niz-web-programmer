import type { Action, CodeRef } from '../../format/types'
import { codesOf } from './describe'

const DEFAULT_INTERVAL = 30

/** Switches an action to another type, carrying its codes over where that makes sense. */
export function convertAction(a: Action, to: Action['type'], fallback: CodeRef): Action {
  const codes = codesOf(a)
  switch (to) {
    case 'none':
      return { type: 'none' }
    case 'key':
      return { type: 'key', code: codes[0] ?? fallback }
    case 'combo':
      return { type: 'combo', keys: codes.slice(0, 6) }
    case 'emulate':
      return { type: 'emulate', keys: (codes.length ? codes : [fallback]).slice(0, 6), interval: DEFAULT_INTERVAL }
    case 'macro':
      return {
        type: 'macro',
        play: 'repeat',
        repeat: 1,
        interval: DEFAULT_INTERVAL,
        steps: (codes.length ? codes : [fallback]).map((tap) => ({ tap })),
      }
    case 'raw':
      return a
  }
}
