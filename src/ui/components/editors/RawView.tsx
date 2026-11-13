import type { Action } from '../../../format/types'
import './editors.css'

/** Read-only view of a slot the decoder kept byte-exact (the inspector's type lead says what it means). */
export function RawView({ action }: { action: Extract<Action, { type: 'raw' }> }) {
  return (
    <div className="editor">
      <details className="raw-details">
        <summary>技术细节</summary>
        <p>
          这个键位的数据无法识别成普通动作（可能是 KB84 不常用的格式），完整的数据包会原样保留，写入时按原样写回。
          如果读取时宏缺了续包，就不能写回（键盘可能把后面的键位当成它的续包），需要先换成其他动作。
        </p>
        {action.packets.map((p, i) => (
          <pre key={i} className="raw-hex mono" aria-label={`数据包 ${i + 1}`}>
            {p.match(/.{1,32}/g)?.map((line) => line.match(/../g)?.join(' ')).join('\n')}
          </pre>
        ))}
      </details>
    </div>
  )
}
