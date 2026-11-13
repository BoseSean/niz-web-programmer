/** File import/export helpers: Blob downloads, file names, KB84 .pro export with a list of unrepresentable keys. */
import { keyById } from '../../device/layout'
import type { LayerId } from '../../device/types'
import type { NormalizedProfile } from '../../format/types'
import { toProFile } from '../../kb84/pro'
import { LAYER_ZH } from './describe'
import { issueWhere } from './issues'

export function downloadText(fileName: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function stampedName(prefix: string, ext: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`
  return `${prefix}-${stamp}.${ext}`
}

export type FileKind = 'json' | 'pro'

export function fileKind(name: string): FileKind | null {
  const ext = /\.([^.]+)$/.exec(name.toLowerCase())?.[1]
  return ext === 'json' ? 'json' : ext === 'pro' ? 'pro' : null
}

export interface ProBlocker {
  /** JSON-pointer-like location of the action KB84 cannot store. */
  path: string
  where: string
  reason: string
  layer?: LayerId
  keyId?: string
}

/** Same words as the issues panel (issues.ts) for the same problems. */
function reasonZh(message: string): string {
  if (/raw device slot/.test(message)) return '无法识别的键位不能保存到 .pro'
  if (/has no KB84 label/.test(message)) return 'KB84 无法把这个代码放进列表（组合键 / 宏 / 连发）'
  if (/cannot be stored in a KB84 (library|list)/.test(message)) return 'KB84 无法保存这种动作'
  if (/wait steps are not allowed/.test(message)) return '统一间隔的宏不能包含“等待”步骤（按键之间改用“逐步设置”）'
  return message
}

/**
 * Exports a .pro file. Every action toProFile rejects is collected (and left empty in the export, so the user can
 * decide whether that is acceptable): `text` is the file with those keys cleared.
 */
export function exportPro(p: NormalizedProfile): { text: string; blockers: ProBlocker[] } {
  const blockers: ProBlocker[] = []
  let work: NormalizedProfile = p
  // Original positions of the library entries still in `work` (removing one shifts the later indices).
  const libIndex = {
    combos: (p.library?.combos ?? []).map((_, i) => i),
    macros: (p.library?.macros ?? []).map((_, i) => i),
    emulates: (p.library?.emulates ?? []).map((_, i) => i),
  }
  for (let guard = 0; guard < 400; guard++) {
    try {
      return { text: toProFile(work), blockers }
    } catch (e) {
      const msg = (e as Error).message
      const m = /^(\/[^:]*): (.*)$/.exec(msg)
      if (!m) throw e
      const [, path, rest] = m
      const key = /^\/layers\/(base|fn)\/([^/]+)/.exec(path)
      const lib = /^\/library\/(combos|macros|emulates)\/(\d+)/.exec(path)
      if (key) {
        const layer = key[1] as LayerId
        blockers.push({
          path,
          layer,
          keyId: key[2],
          where: `${LAYER_ZH[layer]} · ${keyById(key[2])?.label ?? key[2]}`,
          reason: reasonZh(rest),
        })
        work = { ...work, layers: { ...work.layers, [layer]: { ...work.layers[layer], [key[2]]: { type: 'none' } } } }
      } else if (lib && work.library) {
        const group = lib[1] as 'combos' | 'macros' | 'emulates'
        const idx = Number(lib[2])
        const orig = libIndex[group][idx] ?? idx
        const at = `/library/${group}/${orig}`
        blockers.push({ path: at, where: issueWhere(at), reason: reasonZh(rest) })
        libIndex[group].splice(idx, 1)
        work = { ...work, library: { ...work.library, [group]: work.library[group]?.filter((_, i) => i !== idx) } }
      } else throw e
    }
  }
  throw new Error('KB84 .pro export did not converge')
}
