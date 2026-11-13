/** Chinese wording and locations for FormatIssues produced by format/normalize.ts and kb84/pro.ts. */
import { codeById } from '../../device/codes'
import { keyById } from '../../device/layout'
import type { LayerId } from '../../device/types'
import type { Action, FormatIssue } from '../../format/types'
import { groupLabel, type LibraryGroup } from '../state/library'
import { ACTION_ZH, LAYER_ZH } from './describe'

/** Replaces quoted code ids ("KeyA") with their Chinese names. */
const nameCodes = (s: string) => s.replace(/"([A-Za-z][A-Za-z0-9]*)"/g, (m, id: string) => {
  const info = codeById(id)
  return info ? `「${info.zh}」` : m
})

const actionZh = (type: string) => ACTION_ZH[type as Action['type']] ?? type

type Rule = [RegExp, (...m: string[]) => string]

const RULES: Rule[] = [
  [/^Expected a code id or a number 1\.\.255, got (.*)$/, (_, v) => `应为按键代码或 1..255 的数字，实际为 ${v}`],
  [/^Code (\d+) is not an integer 1\.\.255$/, (_, v) => `代码 ${v} 不是 1..255 的整数`],
  [/^Unknown code id (.*)$/, (_, v) => `未知的按键代码 ${v}`],
  [/^Code (\d+) is not a known device code; it is sent as-is$/, (_, v) => `代码 ${v} 不是已知的设备代码，将原样发送`],
  [/^Unknown property "(.*)" ignored$/, (_, k) => `未知属性 “${k}”，已忽略`],
  [/^A combo needs an array of codes$/, () => '组合键需要一个按键列表'],
  [/^An emulate needs an array of codes$/, () => '连发需要一个按键列表'],
  [/^A combo needs (\d+)\.\.(\d+) codes, got (\d+)$/, (_, a, b, n) => `组合键需要 ${a}–${b} 个键，当前 ${n} 个`],
  [/^An emulate needs (\d+)\.\.(\d+) codes, got (\d+)$/, (_, a, b, n) => `连发需要 ${a}–${b} 个键，当前 ${n} 个`],
  [/^MouseDoubleClick is only allowed as a single key action$/, () => '「左键双击」只能单独设置为按键，不能放进组合键、宏或连发'],
  [/^play must be .*$/, () => '播放方式必须是 按一下播放 / 按住时播放 / 按一下开/关 之一'],
  [/^play "repeat" needs repeat 1\.\.(\d+)$/, (_, n) => `播放遍数必须是 1–${n} 的整数`],
  [/^repeat is only allowed with play "repeat"$/, () => '只有“按一下播放”方式才能设置播放遍数'],
  [/^interval must be an integer 0\.\.(\d+) \(ms\)$/, (_, n) => `间隔必须是 0–${n} 的整数（毫秒）`],
  [/^interval must be an integer 0\.\.(\d+)$/, (_, n) => `连发间隔必须是 0–${n} 的整数`],
  [/^A macro needs a steps array$/, () => '宏需要步骤列表'],
  [/^A step must be exactly one of .*$/, () => '每一步必须是 按下 / 松开 / 单击 / 等待 之一'],
  [/^wait steps are not allowed with a fixed interval.*$/, () => '统一间隔的宏不能包含“等待”步骤（按键之间改用“逐步设置”）'],
  [/^wait must be an integer 0\.\.(\d+) \(ms\)$/, (_, n) => `等待时间必须是 0–${n} 的整数（毫秒）`],
  [/^A wait before the first event is ignored$/, () => '第一个按键之前的等待会被忽略'],
  [/^A wait after the last event is ignored$/, () => '最后一个按键之后的等待会被忽略'],
  [/^Consecutive waits add up to (\d+) ms; at most (\d+) ms fit between two events$/, (_, a, b) => `连续等待合计 ${a} ms，两个按键之间最多 ${b} ms`],
  [/^Code 200 cannot be used in a macro with recorded timing.*$/, () => '代码 200 是延时标记，不能用在“逐步设置”的宏里'],
  [/^(.*) is already held; this would release it$/, (_, c) => `${c} 已经处于按下状态，这一步实际会松开它`],
  [/^(.*) is not held; this would press it$/, (_, c) => `${c} 没有被按下，这一步实际会按下它`],
  [/^A macro needs at least one down\/up\/tap step$/, () => '宏至少需要一个按键步骤'],
  [/^Still held when the macro ends: (.*)$/, (_, c) => `宏结束时这些键仍处于按下状态：${c}`],
  [/^Macro data is (\d+) bytes; KB84 allows at most (\d+)$/, (_, a, b) => `这个宏太长，超出了容量（${a} / ${b} 字节）`],
  [/^raw needs a non-empty array of hex packets$/, () => '无法识别的键位至少需要一个数据包'],
  [/^Each packet must be (\d+) bytes of hex.*$/, (_, n) => `每个数据包必须是 ${n} 字节的十六进制`],
  [/^Packet must start with (.*?)(?: \(layer (\w+), key (\d+)\))?$/, (_, h) => `数据包必须以 ${h} 开头（与所在键位一致）`],
  [/^Expected an action object, a code or null, got (.*)$/, (_, v) => `无法识别的动作：${v}`],
  [/^Unknown action type (.*)$/, (_, v) => `未知的动作类型 ${v}`],
  [/^(.*) appears twice in the combo; it is sent twice, as KB84 does$/, (_, c) => `${c} 在组合键里重复出现（会照样发送两次，与 KB84 相同）`],
  [/^The first packet announces (\d+) packet\(s\), got (\d+).*$/, (_, a, b) =>
    `首个数据包表明这个槽位有 ${a} 个包，实际只有 ${b} 个。不完整的宏不能写回，请换成其他动作`],
  [/^Packet #(\d+) does not repeat the 11-byte macro header of packet #1$/, (_, n) => `数据包 ${n} 的 11 字节宏头与数据包 1 不一致，不能写回`],
  [/^format must be .*$/, () => '不是 Plum Keymap 文件（format 字段不对）'],
  [/^Unsupported version (.*) \(expected 1\)$/, (_, v) => `不支持的版本 ${v}（应为 1）`],
  [/^device must be "84EC-S", got (.*)$/, (_, v) => `这个配置是给 ${v} 的，不是 84EC-S`],
  [/^(name|description) must be a string$/, (_, k) => `${k} 必须是字符串`],
  [/^inherit must be .*$/, () => 'inherit 只能是 "factory" 或 "none"'],
  [/^layers must be an object.*$/, () => '缺少 layers（需要 base 和 fn 两层）'],
  [/^Unknown layer "(.*)".*$/, (_, l) => `未知的层 “${l}”（只有 base 和 fn）`],
  [/^(base|fn) must be an object mapping key ids to actions$/, (_, l) => `${l} 层必须是“键 id → 动作”的对象`],
  [/^Unknown key id "(.*)"$/, (_, k) => `未知的键 id “${k}”`],
  [/^No key has Fn on the base layer; the Fn layer cannot be reached$/, () => '基础层上没有任何 Fn 键，写入后将无法进入 Fn 层'],
  [/^Fn is set on the (base|fn) layer of "(.*)" but not on its (base|fn) layer; set it on both$/, (_, has, k, lacks) =>
    `“${keyById(k)?.label ?? k}”的${LAYER_ZH[has as LayerId]}是 Fn，但${LAYER_ZH[lacks as LayerId]}不是；请在两层同时设置 Fn`],
  [/^The (\w+) library holds only (\w+) actions, got (\w+)$/, (_, _g, k, t) => `这一组只能保存${actionZh(k)}，这里是${actionZh(t)}`],
  [/^library must be an object$/, () => 'library 必须是对象'],
  [/^Expected a "#rrggbb" color$/, () => '颜色应为 "#rrggbb" 格式'],
  [/^Invalid JSON: (.*)$/, (_, m) => `不是有效的 JSON：${m}`],
  // KB84 .pro import
  [/^root element is <(.*)>, expected <KB84>$/, (_, r) => `不是 KB84 配置文件（根元素是 <${r}>）`],
  [/^missing section <(.*)>$/, (_, s) => `缺少 <${s}> 段`],
  [/^section <(.*)> is out of order.*$/, (_, s) => `<${s}> 段的顺序不对`],
  [/^unknown key label "(.*)" \(KB84 would send code 0\)$/, (_, l) => `无法识别的按键名称 “${l}”`],
  [/^empty item \(gap in the x IDs\)$/, () => '列表中有空项（编号不连续）'],
  [/^macro has no key events$/, () => '宏里没有任何按键'],
  [/^a key appears twice in the combo; it is kept, as KB84 sends it$/, () => '组合键里有重复的键，已按 KB84 的发送方式保留'],
  [/^line (\d+): AREA ID 0 is not a key; ignored$/, (_, l) => `第 ${l} 行：AREA ID 0 不对应任何键，已忽略`],
  [/^KEY ID=(\d+) Level=(\d) is missing; treated as empty$/, (_, n, l) => `缺少键 ${n}（第 ${Number(l) + 1} 层），按“无”处理`],
  [/^"(.*)": the keyboard toggles keys, so this (presses|releases) it$/, (_, l, d) =>
    `“${l}”：键盘按“按一次切换”处理，这一步实际会${d === 'presses' ? '按下' : '松开'}它`],
  [/^library entry "(.*)" is empty; skipped$/, (_, n) => `库条目“${n}”为空，已跳过`],
  [/^library combo "(.*)" has a single key; skipped$/, (_, n) => `库中的组合键“${n}”只有一个键，已跳过`],
  [/^(.*) (\S+) is outside (\d+)\.\.(\d+)$/, (_, w, v, a, b) => `${w} 的值 ${v} 超出范围 ${a}–${b}`],
]

export function issueMessageZh(message: string): string {
  for (const [re, fn] of RULES) {
    const m = re.exec(message)
    if (m) return nameCodes(fn(...m))
  }
  return message
}

export interface IssueTarget {
  layer: LayerId
  keyId: string
  /** Remainder of the path inside the action, e.g. "/steps/3". */
  sub: string
}

export function issueTarget(path: string): IssueTarget | null {
  const m = /^\/layers\/(base|fn)\/([^/]+)(\/.*)?$/.exec(path)
  if (!m || !keyById(m[2])) return null
  return { layer: m[1] as LayerId, keyId: m[2], sub: m[3] ?? '' }
}

/** "第 4 步" etc. for the part of a path inside an action. */
export function subPathZh(sub: string): string {
  const parts: string[] = []
  const re = /\/(steps|keys|packets|interval|repeat|play|code)(?:\/(\d+))?/g
  for (const m of sub.matchAll(re)) {
    const n = m[2] !== undefined ? Number(m[2]) + 1 : null
    if (m[1] === 'steps') parts.push(n ? `第 ${n} 步` : '步骤')
    else if (m[1] === 'keys') parts.push(n ? `第 ${n} 个键` : '按键列表')
    else if (m[1] === 'packets') parts.push(n ? `数据包 ${n}` : '数据包')
    else parts.push({ interval: '间隔', repeat: '播放遍数', play: '播放方式', code: '按键' }[m[1]]!)
  }
  return parts.join(' · ')
}

/** Where an issue is, in words: "Fn 层 · J · 第 3 步", "动作库 · 宏 第 1 项", "文件". */
export function issueWhere(path: string): string {
  const t = issueTarget(path)
  if (t) {
    const key = keyById(t.keyId)!
    return [LAYER_ZH[t.layer], key.label, subPathZh(t.sub)].filter(Boolean).join(' · ')
  }
  const lib = /^\/library\/(combos|macros|emulates)(?:\/(\d+))?/.exec(path)
  if (lib) {
    const g = `动作库 · ${groupLabel(lib[1] as LibraryGroup)}`
    return lib[2] !== undefined ? `${g} 第 ${Number(lib[2]) + 1} 项` : g
  }
  if (path === '/layers/base') return LAYER_ZH.base
  if (path.startsWith('/backlight/')) return `背光 ${path.slice(11)}`
  return path === '' ? '文件' : path
}

export const sortIssues = (issues: readonly FormatIssue[]) =>
  [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
