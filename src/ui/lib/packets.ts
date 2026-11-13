import { keyByNo } from '../../device/layout'
import { CMD } from '../../protocol/codec'

const SLOT_TYPE = ['按键', '模拟击键', '宏', '宏（按住）', '宏（开关）']

/** Short Chinese meaning of a report, for the log. */
export function describePacket(p: Uint8Array): string {
  if (p[0] === CMD.END && p[1] === CMD.END) return '读取结束'
  if (p[0] !== 0) return ''
  switch (p[1]) {
    case CMD.SLOT: {
      const key = keyByNo(p[3])
      const what = p[4] === 0 && p[5] === 0 ? '空' : (SLOT_TYPE[p[4]] ?? `类型 ${p[4]}`)
      return `${p[2] === 2 ? 'Fn 层' : '基础层'} ${key?.label ?? p[3]} · ${what}`
    }
    case CMD.WRITE_BEGIN:
      return '写入开始'
    case CMD.READ:
      return '读取请求'
    case CMD.END:
      return '写入结束'
    case CMD.VERSION:
      return '版本'
    case CMD.LIGHT_READ:
      return '灯光读取'
    case CMD.LIGHT_END:
      return '灯光结束'
    default:
      return ''
  }
}
