import { useEffect, useId, useRef } from 'react'
import { keyById } from '../../device/layout'
import type { FormatIssue } from '../../format/types'
import type { ChangeRow } from '../lib/changes'
import { formatSavedAt } from '../lib/describe'
import { issueMessageZh, issueWhere } from '../lib/issues'
import type { Busy } from '../state/useDevice'
import { Dialog } from './Dialog'
import { Icon } from './Icon'
import './WriteDialog.css'

export type WriteOutcome =
  | { kind: 'verified' }
  | { kind: 'office' }
  | { kind: 'mismatch'; rows: ChangeRow[]; incomplete: boolean }
  /**
   * `reverify`: the failure came from 重新校验, so nothing was written this time. `partial` (default true): part of the
   * table may be on the keyboard; false when the write stopped before anything was sent.
   */
  | { kind: 'error'; message: string; reverify?: boolean; partial?: boolean }

export type WriteStage =
  /** Reading a keyboard that was never read, before the confirmation (for the diff and the pre-write backup). */
  | { stage: 'preparing' }
  | { stage: 'confirm' }
  /** `reverify`: only reading back (重新校验), nothing is written. */
  | { stage: 'writing'; reverify?: boolean }
  | { stage: 'result'; outcome: WriteOutcome }

interface Props {
  stage: WriteStage
  changes: ChangeRow[]
  /** What the changes are compared with. */
  baseline: 'device' | 'factory'
  warnings: FormatIssue[]
  /** Extra cautions (Fn+F12 changed, …): shown as 写入后可能回不来. */
  cautions: string[]
  busy: Busy | null
  /** 另存为文件: export what is on the keyboard. */
  onBackup: () => void
  onConfirm: () => void
  onReverify: () => void
  onClose: () => void
  /** The automatic backup taken just before this write (null when it failed or there was none). */
  backup?: { savedAt: number; source: 'device' | 'pre-read' } | null
  /** 改回写入前的键位: put the pre-write backup back on the page (offered after every result that has a backup). */
  onRestoreBackup?: () => void
  /**
   * Why the last read may not show what the keyboard holds. 'uncertain' (or true): it gave the factory map and the M
   * light may have been off, so the write may overwrite the user's keys. 'office': the keyboard holds the user's keys,
   * but the last read came back in Office mode (the page is still built on the user's keys).
   */
  modeWarning?: boolean | 'uncertain' | 'office'
  /** 先重新读取键盘 (with modeWarning): read the keyboard again, keeping the page. */
  onReread?: () => void
  /** 先重新读取键盘 failed: why. The confirmation still compares with what was known before. */
  rereadError?: string | null
  /** 再写一次 after a mismatch or an interrupted write. */
  onRetry?: () => void
  /** 打开按键测试 after a verified write. */
  onOpenTester?: () => void
  /** What this write changed on the keyboard, for 试试刚改的键. */
  written?: ChangeRow[]
  /** The written map equals the factory map, so a verified read-back does not tell the M light is on. */
  writtenIsFactory?: boolean
  /** The pre-write backup failed (this write has none). */
  backupFailed?: boolean
  /** The read before the confirmation failed: the changes are compared with the factory map. */
  preReadFailed?: boolean
  /** 取消 while preparing; default onClose. */
  onCancelPrepare?: () => void
}

const SHOWN_ROWS = 40
const SHOWN_TRIES = 3

function Rows({ rows, fromLabel, toLabel }: { rows: ChangeRow[]; fromLabel: string; toLabel: string }) {
  return (
    <div className="changes">
      <table>
        <thead>
          <tr><th>键位</th><th>{fromLabel}</th><th /><th>{toLabel}</th></tr>
        </thead>
        <tbody>
          {rows.slice(0, SHOWN_ROWS).map((r) => (
            <tr key={`${r.layer}/${r.keyId}`}>
              <td className="changes-where">{r.where}</td>
              <td className="muted">{r.from}</td>
              <td aria-hidden="true">→</td>
              <td>{r.to}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > SHOWN_ROWS && <p className="muted">以及另外 {rows.length - SHOWN_ROWS} 个键位。</p>}
    </div>
  )
}

/** Progress bar named by the lead above it; `pct` null slides (the step reports no progress). */
function Progress({ pct, labelledBy }: { pct: number | null; labelledBy: string }) {
  return (
    <div className="progress" role="progressbar" aria-labelledby={labelledBy} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      <span style={{ width: `${pct ?? 100}%` }} className={pct === null ? 'is-indeterminate' : undefined} />
    </div>
  )
}

/** 试试刚改的键: the first few written keys and how to press them. */
function TryKeys({ rows }: { rows: ChangeRow[] }) {
  return (
    <div className="write-try">
      <h4>试试刚改的键：</h4>
      <ul>
        {rows.slice(0, SHOWN_TRIES).map((r) => {
          const label = keyById(r.keyId)?.label ?? r.where
          return (
            <li key={`${r.layer}/${r.keyId}`}>
              <b>{label}</b> → {r.to}：{r.layer === 'fn' ? `按住 Fn 再按 ${label}` : `直接按 ${label}`}
            </li>
          )
        })}
      </ul>
      {rows.length > SHOWN_TRIES && <p className="muted">以及另外 {rows.length - SHOWN_TRIES} 个键位。</p>}
    </div>
  )
}

/** `message` ending in one full stop, whether or not it came with one. */
const stop = (message: string) => {
  const head = message.trim().replace(/[。．.]+$/, '')
  return head && `${head}。`
}

/** `message` and a follow-up sentence, without doubling the full stop the message already ends with. */
const sentence = (message: string, then: string) => stop(message) + then

export function WriteDialog(p: Props) {
  const { stage } = p
  const leadId = useId()
  const dangerId = useId()
  const resultId = useId()
  const body = useRef<HTMLElement | null>(null)
  const mark = (el: HTMLElement | null) => {
    body.current = el
  }
  const outcome = stage.stage === 'result' ? stage.outcome.kind : null
  // The dialog node stays the same from stage to stage, so nothing announces the new content: the confirmation and
  // the result take focus at their first line (the outcome heading reads its sentence as its description). Moving on
  // to the progress removes the button that had focus (确认写入, 再写一次…): keep focus in the dialog, not on the page.
  useEffect(() => {
    const el = body.current
    if (stage.stage === 'confirm' || stage.stage === 'result') {
      el?.focus()
      return
    }
    const dlg = el?.closest<HTMLElement>('[role="dialog"]')
    if (dlg && !dlg.contains(document.activeElement)) dlg.focus()
  }, [stage.stage, outcome])

  if (stage.stage === 'preparing') {
    const b = p.busy
    const cancel = p.onCancelPrepare ?? p.onClose
    return (
      <Dialog
        title="写入键盘"
        className="write-dialog"
        onClose={cancel}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={cancel}>取消</button>
          </>
        }
      >
        <p className="lead" id={leadId} ref={mark}>正在读取键盘里现在的键位，用来对比和备份…</p>
        <Progress pct={b && b.total ? Math.round((b.done / b.total) * 100) : 0} labelledBy={leadId} />
        <p className="muted mono">{b && b.total ? `${b.done}/${b.total}` : '…'}</p>
      </Dialog>
    )
  }

  if (stage.stage === 'writing') {
    const b = p.busy
    const verifying = b?.op === 'verify'
    // A keyboard that was never read is read first, for the pre-write backup.
    const preRead = b?.op === 'read'
    const reading = (verifying && !!stage.reverify) || preRead
    // The read-back inside a write reports no progress: show an indeterminate bar for it.
    const indeterminate = verifying && !reading
    const pct = indeterminate ? null : b && b.total ? Math.round((b.done / b.total) * 100) : verifying ? 100 : 0
    return (
      <Dialog title={stage.reverify ? '正在重新校验' : '正在写入键盘'} className="write-dialog" locked>
        <p className="lead" id={leadId} ref={mark}>
          {stage.reverify
            ? '正在读取键盘并与写入的内容比较…'
            : preRead
              ? '写入前先读取键盘里现在的键位，留作备份…'
              : verifying
                ? '写入完成，正在读回校验…'
                : '正在写入键盘，请不要拔线。'}
        </p>
        <Progress pct={pct} labelledBy={leadId} />
        <p className="muted mono">{pct !== null && b && b.total ? `${pct}%` : '…'}</p>
      </Dialog>
    )
  }

  if (stage.stage === 'result') {
    const o = stage.outcome
    const canRestore = !!p.backup && !!p.onRestoreBackup
    const verifyFailed = o.kind === 'error' && !!o.reverify
    const retry = o.kind === 'mismatch' || (o.kind === 'error' && !verifyFailed) ? p.onRetry : undefined
    const footer = (
      <>
        {canRestore && (
          <>
            <button type="button" className="link-btn write-restore" onClick={p.onRestoreBackup} title="把写入前的键位载入到页面，确认后再写入键盘">
              改回写入前的键位
            </button>
            <span className="spacer" />
          </>
        )}
        {o.kind === 'verified' && (
          <>
            {p.onOpenTester && (
              <button type="button" className="btn" onClick={p.onOpenTester}>
                <Icon name="keyboard" />打开按键测试
              </button>
            )}
            <button type="button" className="btn btn-ink" onClick={p.onClose}>好的</button>
          </>
        )}
        {o.kind === 'office' && (
          <>
            <button type="button" className="btn btn-ghost" onClick={p.onClose}>稍后</button>
            <button type="button" className="btn btn-ink" onClick={p.onReverify}>
              <Icon name="read" />M 灯已亮，重新校验
            </button>
          </>
        )}
        {(o.kind === 'mismatch' || o.kind === 'error') && (
          <>
            <button type="button" className={`btn ${retry || verifyFailed ? 'btn-ghost' : 'btn-ink'}`} onClick={p.onClose}>关闭</button>
            {retry && (
              <button type="button" className="btn btn-ink" onClick={retry}>
                <Icon name="write" />再写一次
              </button>
            )}
            {verifyFailed && (
              <button type="button" className="btn btn-ink" onClick={p.onReverify}>
                <Icon name="read" />再校验一次
              </button>
            )}
          </>
        )}
      </>
    )
    return (
      <Dialog title="写入结果" className="write-dialog" onClose={p.onClose} footer={footer} wide={o.kind === 'mismatch'}>
        {o.kind === 'verified' && (
          <div className="result result-ok">
            <span className="seal" aria-hidden="true">成</span>
            <div>
              <h3 ref={mark} tabIndex={-1} aria-describedby={resultId}>写入成功，已校验</h3>
              <p id={resultId}>
                {p.writtenIsFactory
                  ? '读回的键位和页面上完全一致。在编程模式（M 灯亮）下就是这些键位。'
                  : '读回的键位和页面上完全一致。键盘现在是编程模式（M 灯亮），改动已经生效。'}
              </p>
              {!!p.written?.length && <TryKeys rows={p.written} />}
            </div>
          </div>
        )}
        {o.kind === 'office' && (
          <div className="result result-warn">
            <Icon name="warn" size={28} />
            <div>
              <h3 ref={mark} tabIndex={-1} aria-describedby={resultId}>已写入，还没生效</h3>
              <p id={resultId}>
                键盘现在是办公模式（M 灯灭），所以读回的是出厂键位。改动已经存进键盘，<b>不需要重新写入</b>：<b>按住 Fn+F12 约 2 秒</b>，M 灯亮起后点“M 灯已亮，重新校验”。
              </p>
            </div>
          </div>
        )}
        {o.kind === 'mismatch' && (
          <div className="result result-error">
            <Icon name="error" size={28} />
            <div>
              <h3 ref={mark} tabIndex={-1} aria-describedby={resultId}>校验未通过</h3>
              <p id={resultId}>
                {o.incomplete ? '读回时没有收到全部键位。' : `读回的内容有 ${o.rows.length} 处与写入的不一致${o.rows.length ? '（见下表）' : ''}。`}
                请关闭 KB84 软件后再写一次。
              </p>
              {o.rows.length > 0 && <Rows rows={o.rows} fromLabel="写入" toLabel="读回" />}
            </div>
          </div>
        )}
        {o.kind === 'error' && (
          <div className="result result-error">
            <Icon name="error" size={28} />
            <div>
              <h3 ref={mark} tabIndex={-1} aria-describedby={resultId}>{verifyFailed ? '校验中断' : '写入中断'}</h3>
              <p id={resultId}>
                {sentence(
                  o.message,
                  verifyFailed
                    ? '这次只是读取，键盘里的键位没有改动。'
                    : o.partial === false
                      ? '键盘没有收到任何改动，页面上的修改还在。'
                      : '键盘里的键位可能只写了一部分，页面上的修改还在。',
                )}
              </p>
            </div>
          </div>
        )}
        {p.backup ? (
          <p className="muted write-backup-note">写入前的键位已自动备份（{formatSavedAt(p.backup.savedAt)}）。</p>
        ) : (
          p.backupFailed && <p className="muted write-backup-note">这次没有自动备份。</p>
        )}
      </Dialog>
    )
  }

  const n = p.changes.length
  const fromDevice = p.baseline === 'device'
  const unread = p.preReadFailed ? '没能读取键盘' : '还没有读取键盘'
  const mode = p.modeWarning === true ? 'uncertain' : p.modeWarning || null
  // Focus starts at the first thing to read: the failed re-read, the M-light warning, the cautions or the lead.
  const first = p.rereadError ? 'reread' : mode ? 'mode' : p.cautions.length ? 'danger' : 'lead'
  const start = (block: typeof first) => (block === first ? { ref: mark, tabIndex: -1 } : {})
  return (
    <Dialog
      title="写入键盘"
      className="write-dialog"
      onClose={p.onClose}
      wide
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={p.onClose}>取消</button>
          {mode && p.onReread && (
            <button type="button" className="btn" onClick={p.onReread} title="重新读取键盘里的键位（页面上的修改保留）">
              <Icon name="read" />先重新读取键盘
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={p.onConfirm}>
            <Icon name="check" />{mode ? '仍然写入' : '确认写入'}
          </button>
        </>
      }
    >
      {p.rereadError && (
        <div className="note note-warn write-reread-warn" {...start('reread')}>
          <Icon name="warn" />
          <span>重新读取失败：{stop(p.rereadError)}</span>
        </div>
      )}
      {mode && (
        <div className="note note-warn write-mode-warn" {...start('mode')}>
          <Icon name="warn" />
          {mode === 'office' ? (
            <span>
              键盘现在多半是办公模式（M 灯灭）：刚才读到的是出厂键位，但键盘里存着你改过的键位。写入会覆盖它们。请先
              <b>按住 Fn+F12 约 2 秒</b>让 M 灯亮起，再点“先重新读取键盘”。自动备份会保存你上次读到或写入的键位。
            </span>
          ) : (
            <span>
              上次读到的是出厂键位，还不确定当时 M 灯是否亮着。如果键盘里原本有你改过的键位，
              {p.writtenIsFactory ? '这次写入会把它们改成出厂键位' : '这次写入会把它们覆盖'}，自动备份里也只有出厂键位。
            </span>
          )}
        </div>
      )}
      {p.cautions.length > 0 && (
        <div className="write-danger" role="group" aria-labelledby={dangerId} {...start('danger')}>
          <h3 id={dangerId}><Icon name="warn" />写入后可能回不来</h3>
          <ul>
            {p.cautions.map((c) => <li key={c}>{c}</li>)}
            <li>
              万一回不来：同时按住 <kbd>Esc</kbd> + <kbd>Delete</kbd> + <kbd>左 Ctrl</kbd> + <kbd>→</kbd> 约 5 秒，键盘复位。
            </li>
          </ul>
        </div>
      )}
      <p className="lead" {...start('lead')}>
        {fromDevice
          ? n ? `将把页面上的键位写入键盘，有 ${n} 个键位会改变：` : '页面上的键位与键盘里的一致；仍会重新写入全部键位。'
          : n
            ? `${unread}，下面是与出厂键位的比较；写入会覆盖键盘里的全部键位。有 ${n} 处不同：`
            : `${unread}；页面上的键位就是出厂键位，写入会把键盘里的全部键位改成出厂键位。`}
      </p>
      {n > 0 && <Rows rows={p.changes} fromLabel={fromDevice ? '键盘里现在' : '出厂'} toLabel="写入后" />}
      {p.warnings.length > 0 && (
        <details className="write-hints">
          <summary>{p.warnings.length} 条提示（不影响写入）</summary>
          <ul className="insp-issues">
            {p.warnings.map((w, i) => (
              <li key={i} className="issue issue-warning">
                <Icon name="warn" size={14} />
                <span><b>{issueWhere(w.path)}：</b>{issueMessageZh(w.message)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <ul className="write-checks">
        {fromDevice ? (
          <li className="write-check-ok">
            <Icon name="check" size={14} />
            <span>
              写入前自动备份键盘里现在的键位（可在“方案 → 自动备份”里载入）{' '}
              <button type="button" className="link-btn" onClick={p.onBackup} title="把键盘里现在的键位另存为文件">另存为文件</button>
            </span>
          </li>
        ) : (
          <li>
            <Icon name="info" size={14} />
            <span>写入前会再读取一次键盘并备份；读不到就这次不备份</span>
          </li>
        )}
        <li className="write-check-ok">
          <Icon name="check" size={14} />
          <span>写完自动读回校验</span>
        </li>
        <li className="write-cond">
          <Icon name="info" size={14} />
          <span>生效条件：F12 上的 M 灯亮（编程模式）</span>
        </li>
      </ul>
    </Dialog>
  )
}
