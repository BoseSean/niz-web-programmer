import { useEffect, useMemo, useRef, useState } from 'react'
import { describePacket } from '../lib/packets'
import { hexBytes, usePacketLog, type PacketEntry, type PacketLog } from '../state/packetLog'
import { Icon } from './Icon'
import { Segmented } from './Segmented'

const SHOWN = 400
/** Hex with the trailing zero padding folded ("… 00×52"). */
function shortHex(b: Uint8Array): { hex: string; pad: number } {
  let end = b.length
  while (end > 0 && b[end - 1] === 0) end--
  end = Math.max(end, 2)
  return { hex: hexBytes(b.subarray(0, end)), pad: b.length - end }
}

const fmtTime = (ms: number) => (ms / 1000).toFixed(3).padStart(8, ' ')

const lineOf = (e: PacketEntry) => `${fmtTime(e.t)} ${e.dir === 'out' ? 'OUT' : 'IN '} ${hexBytes(e.bytes)}`

/**
 * 通信日志: collapsible drawer with every HID report sent and received. A diagnostics tool, so App can hide it
 * (visible=false renders nothing and stops listening).
 */
export function PacketLogDrawer({ log, visible = true }: { log: PacketLog; visible?: boolean }) {
  return visible ? <Drawer log={log} /> : null
}

function Drawer({ log }: { log: PacketLog }) {
  const entries = usePacketLog(log)
  const [open, setOpen] = useState(false)
  const [dir, setDir] = useState<'all' | 'out' | 'in'>('all')
  const [filter, setFilter] = useState('')
  const [copied, setCopied] = useState(false)
  const list = useRef<HTMLDivElement>(null)

  const visible = useMemo(() => {
    const f = filter.replace(/\s+/g, '').toUpperCase()
    return entries.filter((e) => (dir === 'all' || e.dir === dir) && (!f || hexBytes(e.bytes).replace(/ /g, '').includes(f)))
  }, [dir, entries, filter])

  useEffect(() => {
    const el = list.current
    if (open && el) el.scrollTop = el.scrollHeight
  }, [open, visible.length])

  const copy = async () => {
    const text = visible.map(lineOf).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className={`log${open ? ' is-open' : ''}`} aria-label="通信日志">
      <button type="button" className="log-tab" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="terminal" size={15} />
        通信日志
        {open && <span className="log-count mono" title={`共 ${entries.length} 条记录`}>{entries.length}</span>}
        <Icon name={open ? 'down' : 'up'} size={14} />
      </button>
      {open && (
        <div className="log-body">
          <div className="log-tools">
            <Segmented<'all' | 'out' | 'in'>
              label="方向"
              size="sm"
              value={dir}
              onChange={setDir}
              options={[{ value: 'all', label: '全部' }, { value: 'out', label: '发送 →' }, { value: 'in', label: '← 接收' }]}
            />
            <input type="search" className="log-filter mono" placeholder="按十六进制过滤，如 00 F0 02" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="按十六进制过滤" />
            <span className="muted">{visible.length} 条{visible.length > SHOWN ? `（显示最近 ${SHOWN} 条）` : ''}</span>
            <button type="button" className="btn btn-sm" onClick={copy} disabled={!visible.length}>
              <Icon name={copied ? 'check' : 'copy'} size={14} />
              {copied ? '已复制' : '复制'}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => log.clear()} disabled={!entries.length}>
              <Icon name="trash" size={14} />清空
            </button>
          </div>
          <div className="log-list mono" ref={list}>
            {visible.length === 0 && <p className="muted log-empty">还没有记录。读取或写入时，收发的原始数据会显示在这里。</p>}
            {visible.slice(-SHOWN).map((e) => {
              const { hex, pad } = shortHex(e.bytes)
              return (
                <div key={e.id} className={`log-row log-${e.dir}`}>
                  <span className="log-t">{fmtTime(e.t)}</span>
                  <span className="log-dir">{e.dir === 'out' ? '→' : '←'}</span>
                  <span className="log-hex">{hex}{pad > 0 && <span className="log-pad"> 00×{pad}</span>}</span>
                  <span className="log-what">{describePacket(e.bytes)}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </section>
  )
}
