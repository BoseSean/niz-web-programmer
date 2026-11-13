/**
 * 全部清空: sets every key on both layers to "none". By default the keys that keep the keyboard usable survive:
 * every Fn key (code 156) on either layer and every 办公/编程模式切换 (ProgramMode, code 159), and when the draft has none
 * of them the factory positions are put back (Fn on the 'fn' key of both layers, ProgramMode on Fn-layer F12).
 * The library, name, description and backlight are kept.
 */
import { resolveCodeRef } from '../../device/codes'
import { KEYS } from '../../device/layout'
import { LAYERS, type LayerId } from '../../device/types'
import { canonicalRef } from '../../format/compile'
import type { Action } from '../../format/types'
import type { Draft } from '../state/editor'

export const FN_CODE = 156
export const PROGRAM_MODE_CODE = 159
/** Physical key that holds Fn in the factory map (both layers). */
export const FN_KEY = 'fn'
/** Physical key that holds ProgramMode on the Fn layer in the factory map. */
export const PROGRAM_MODE_KEY = 'f12'

export interface KeptKey {
  layer: LayerId
  keyId: string
  /** What the key keeps: Fn or the mode switch. */
  what: 'fn' | 'mode'
}

export interface ClearResult {
  draft: Draft
  /** Keys that were not cleared (empty when keepFn is false). */
  kept: KeptKey[]
}

const codeValue = (a: Action | undefined): number | undefined =>
  a?.type === 'key' ? resolveCodeRef(a.code)?.value : undefined

/** The draft with every key cleared, except Fn / ProgramMode unless `keepFn` is false. Never mutates its input. */
export function clearAllDraft(draft: Draft, { keepFn = true }: { keepFn?: boolean } = {}): ClearResult {
  const layers = {} as Draft['layers']
  for (const l of LAYERS) layers[l] = Object.fromEntries(KEYS.map((k) => [k.id, { type: 'none' } as Action]))
  const kept: KeptKey[] = []
  if (keepFn) {
    const keep = (layer: LayerId, keyId: string, what: KeptKey['what'], code: number) => {
      layers[layer][keyId] = { type: 'key', code: canonicalRef(code) }
      // Putting Fn back may overwrite a kept mode switch on the same key: keep the list in step with the result.
      const prev = kept.findIndex((k) => k.layer === layer && k.keyId === keyId)
      if (prev >= 0) kept.splice(prev, 1)
      kept.push({ layer, keyId, what })
    }
    for (const l of LAYERS) {
      for (const k of KEYS) {
        const v = codeValue(draft.layers[l][k.id])
        if (v === FN_CODE) keep(l, k.id, 'fn', FN_CODE)
        else if (v === PROGRAM_MODE_CODE) keep(l, k.id, 'mode', PROGRAM_MODE_CODE)
      }
    }
    if (!kept.some((k) => k.layer === 'base' && k.what === 'fn')) {
      for (const l of LAYERS) if (codeValue(layers[l][FN_KEY]) !== FN_CODE) keep(l, FN_KEY, 'fn', FN_CODE)
    }
    if (!kept.some((k) => k.layer === 'fn' && k.what === 'mode') && codeValue(layers.fn[PROGRAM_MODE_KEY]) !== FN_CODE) {
      keep('fn', PROGRAM_MODE_KEY, 'mode', PROGRAM_MODE_CODE)
    }
    kept.sort((a, b) => LAYERS.indexOf(a.layer) - LAYERS.indexOf(b.layer) || KEYS.findIndex((k) => k.id === a.keyId) - KEYS.findIndex((k) => k.id === b.keyId))
  }
  return { draft: { ...draft, layers }, kept }
}
