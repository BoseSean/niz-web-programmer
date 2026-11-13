/** What each key cap of the keyboard view shows: one name for an unchanged key, two once it is changed. */
import { resolveCodeRef } from '../../device/codes'
import { KEYS } from '../../device/layout'
import type { CodeInfo, KeyInfo, LayerId } from '../../device/types'
import type { Action } from '../../format/types'
import type { KeyFace } from '../KeyboardView'
import type { Draft, StatusMap } from '../state/editor'
import { actionFace, describeAction, isNoEffect, isUnverified } from './describe'

const NONE: Action = { type: 'none' }

/**
 * Codes that get no Fn hint on the base layer: unknown device functions (their short name is hex), backlight codes that
 * do nothing on the 84EC-S, and the unverified ones still named after KB84's backlight effects. The title names them.
 */
const quietCode = (info: CodeInfo | undefined) =>
  !info || info.category === 'special' || isNoEffect(info) || (isUnverified(info) && /backlight/i.test(info.note ?? ''))

/** Small text in a base-layer cap's corner: what the key does while Fn is held (undefined when nothing worth showing). */
function fnHint(fn: Action, key: KeyInfo, main: string): string | undefined {
  if (fn.type === 'none' || fn.type === 'raw') return undefined
  if (fn.type === 'key' && quietCode(resolveCodeRef(fn.code)?.info)) return undefined
  const hint = actionFace(fn, key).main
  return hint && hint !== main ? hint : undefined
}

/**
 * Cap faces of one layer. The physical legend and the type tag show only on changed keys and on the Fn layer, so on
 * the base layer two names on a cap mean "changed". Unknown device functions show as "?" (the title names the code).
 * Base-layer caps also carry the Fn-layer function as a hint.
 * The title names both layers; `description` feeds the accessible name ("与出厂不同，未写入，有错误").
 */
export function buildFaces(present: Draft, status: StatusMap, layer: LayerId): Record<string, KeyFace> {
  const out: Record<string, KeyFace> = {}
  for (const k of KEYS) {
    const base = present.layers.base[k.id] ?? NONE
    const fn = present.layers.fn[k.id] ?? NONE
    const a = layer === 'fn' ? fn : base
    const st = status[layer][k.id]
    const face = actionFace(a, k)
    const both = st.changed || layer === 'fn'
    // A single code's category (媒体, 功能…) is in the title; the corner tag is kept for combos, macros and repeats.
    const info = a.type === 'key' ? resolveCodeRef(a.code)?.info : undefined
    const desc = [st.changed && '与出厂不同', st.pending && '未写入', st.errors > 0 && '有错误'].filter(Boolean).join('，')
    out[k.id] = {
      main: info?.category === 'special' ? '?' : face.main,
      legend: both ? face.legend : undefined,
      tag: both && a.type !== 'key' ? face.tag : undefined,
      fn: layer === 'base' ? fnHint(fn, k, face.main) : undefined,
      title: `基础层：${describeAction(base)} / Fn 层：${describeAction(fn)}`,
      changed: st.changed,
      pending: st.pending,
      invalid: st.errors > 0,
      empty: a.type === 'none',
      description: desc,
    }
  }
  return out
}
