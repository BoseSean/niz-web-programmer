import { useEffect, useId } from 'react'
import type { LayerId } from '../../device/types'
import type { ChangeRow } from '../lib/changes'
import { useMenu } from '../lib/useMenu'
import { Icon, type IconName } from './Icon'
import './SyncStatus.css'

interface Props {
  connected: boolean
  /** The keyboard's key map is known (read, or written and verified). */
  read: boolean
  /** Keys whose page value is not on the keyboard (before the first read: edits that differ from the factory map). */
  unsaved: number
  errorCount: number
  /** The last write was verified and nothing changed since. */
  verified?: boolean
  /** A write broke off or a read came back incomplete: what is on the keyboard is unknown until it is read again. */
  deviceStale?: boolean
  /** The unwritten changes, listed when the 「n 处修改未写入」 pill is clicked. */
  pendingRows?: readonly ChangeRow[]
  /** The error pill. Default: scroll the issues panel (#issues) into view. */
  onShowErrors?: () => void
  /** A row of the unwritten-changes list: select that key. */
  onSelectKey?: (layer: LayerId, keyId: string) => void
  /** The 「键盘状态未知」 pill. */
  onReread?: () => void
}

type Kind = 'error' | 'stale' | 'offline' | 'unread' | 'pending' | 'verified' | 'synced'

interface View {
  kind: Kind
  tone: 'error' | 'warn' | 'pending' | 'idle' | 'ok'
  text: string
  /** All that is shown at phone width (the full text stays readable to screen readers). */
  short?: string
  title?: string
}

const ICON: Record<Kind, IconName> = {
  error: 'error',
  stale: 'warn',
  offline: 'plug',
  unread: 'read',
  pending: 'write',
  verified: 'check',
  synced: 'check',
}

/** The first state that applies, in order of what needs attention. */
function view({ connected, read, unsaved: n, errorCount, verified, deviceStale }: Props): View {
  if (errorCount > 0) return { kind: 'error', tone: 'error', text: `${errorCount} 个错误，改正后才能写入`, short: String(errorCount), title: '点这里查看是哪些键' }
  // Only while connected: offline, 重新读取 could not run anyway.
  if (deviceStale && connected)
    return { kind: 'stale', tone: 'warn', text: '键盘状态未知 · 建议重新读取', title: '不确定键盘里现在是什么键位（写入没有完成，或读取不完整）。写入前会先读取键盘，也可以点这里重新读取' }
  if (!connected)
    return n > 0
      ? { kind: 'offline', tone: 'pending', text: `页面上有 ${n} 处修改 · 未连接键盘`, short: String(n) }
      : { kind: 'offline', tone: 'idle', text: '未连接键盘' }
  if (!read)
    return n > 0
      ? { kind: 'unread', tone: 'pending', text: `页面上有 ${n} 处修改 · 写入前会先读取键盘`, short: String(n) }
      : { kind: 'unread', tone: 'idle', text: '还没读取键盘' }
  if (n > 0) return { kind: 'pending', tone: 'pending', text: `${n} 处修改未写入`, short: String(n), title: '看看是哪些键还没写入' }
  if (verified) return { kind: 'verified', tone: 'ok', text: '已写入并校验', title: '读回的键位和页面上完全一致' }
  return { kind: 'synced', tone: 'ok', text: '与键盘一致', title: '页面上的键位和键盘里的一样' }
}

const scrollToIssues = () => document.getElementById('issues')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })

/**
 * One answer to "is what I see on the keyboard?", next to 写入键盘. Errors and a stale keyboard act on a click; the
 * unwritten count opens a non-modal list of the changes (keyboard like a menu), each row selects its key.
 * The pill is the same <button> in every state, so focus survives a change under it (a reread that succeeds, an undo
 * back to no changes); with nothing to do it is aria-disabled. Changes are announced politely; the list itself sits
 * outside the live region.
 */
export function SyncStatus(props: Props) {
  const { pendingRows = [], onShowErrors, onSelectKey, onReread } = props
  const v = view(props)
  const { open, setOpen, root, trigger, pop, close, onMenuKey, onTriggerKey } = useMenu()
  const popId = useId()
  const listable = v.kind === 'pending' && pendingRows.length > 0 && onSelectKey !== undefined
  const act = v.kind === 'error' ? (onShowErrors ?? scrollToIssues) : v.kind === 'stale' ? onReread : listable ? () => setOpen(!open) : undefined

  // The pill changed to another state: the list it opened goes with it, and focus that was in the list (now on
  // <body>) goes back to the pill.
  useEffect(() => {
    if (listable || !open) return
    setOpen(false)
    if (document.activeElement === document.body) trigger.current?.focus()
  }, [listable, open, setOpen, trigger])

  return (
    <div className="sync-wrap" ref={root}>
      <div className="sync-live" aria-live="polite" aria-atomic="true">
        <button
          type="button"
          ref={trigger}
          className={`sync sync-${v.tone}`}
          // the full text where only the count shows (phone width)
          title={v.title ?? (v.short ? v.text : undefined)}
          aria-disabled={act ? undefined : true}
          aria-haspopup={listable ? 'menu' : undefined}
          aria-expanded={listable ? open : undefined}
          aria-controls={listable && open ? popId : undefined}
          onClick={act}
          onKeyDown={listable ? onTriggerKey : undefined}
        >
          {v.tone === 'pending' ? <span className="sync-dot" aria-hidden="true" /> : <Icon name={ICON[v.kind]} size={14} />}
          <span className="sync-text">{v.text}</span>
          {v.short && (
            <span className="sync-short" aria-hidden="true">
              {v.short}
            </span>
          )}
          {listable && <Icon name="down" size={12} />}
        </button>
      </div>
      {open && listable && (
        <div className="menu-pop sync-pop" role="menu" id={popId} aria-label="未写入的修改" ref={pop} onKeyDown={onMenuKey}>
          <div className="menu-group" role="presentation">未写入的修改 · 点一项选中那个键</div>
          {pendingRows.map((r) => (
            <button
              key={`${r.layer}/${r.keyId}`}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close()
                onSelectKey(r.layer, r.keyId)
              }}
            >
              <span className="sync-where">{r.where}</span>
              <small>
                {r.from} → {r.to}
              </small>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
