import { useEffect, useId, useRef, useState } from 'react'
import type { LayerId } from '../../device/types'
import type { FormatIssue } from '../../format/types'
import { issueMessageZh, issueTarget, issueWhere, sortIssues } from '../lib/issues'
import { Icon } from './Icon'

interface Props {
  issues: FormatIssue[]
  onSelect: (layer: LayerId, keyId: string) => void
  /** Change it (e.g. a counter) to open the panel, scroll it into view and focus its header: SyncStatus's error pill. */
  openRequest?: number
}

/**
 * Every validation issue of the working profile; errors block writing. Click one to jump to its key. Nothing is shown
 * when there are none. Errors open it (also when they appear later); warnings alone leave it collapsed.
 */
export function IssuesPanel({ issues, onSelect, openRequest = 0 }: Props) {
  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors
  const hasErrors = errors > 0
  const [open, setOpen] = useState(hasErrors)
  // Errors that appear later (the panel stays mounted while empty) open it too.
  const [hadErrors, setHadErrors] = useState(hasErrors)
  if (hadErrors !== hasErrors) {
    setHadErrors(hasErrors)
    if (hasErrors) setOpen(true)
  }
  const section = useRef<HTMLElement>(null)
  const head = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const handled = useRef(openRequest)
  const reveal = useRef(false)

  useEffect(() => {
    if (openRequest === handled.current) return
    handled.current = openRequest
    reveal.current = true
    setOpen(true)
  }, [openRequest])

  // After an open request, once the list is rendered: bring the panel into view and put focus on its header.
  useEffect(() => {
    if (!open || !reveal.current) return
    reveal.current = false
    section.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    head.current?.focus({ preventScroll: true })
  }, [open, openRequest])

  if (!issues.length) return null
  return (
    <section id="issues" ref={section} className={`issues${errors ? ' has-errors' : ''}`} aria-label="检查结果">
      <button type="button" ref={head} className="issues-head" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={open ? listId : undefined}>
        <Icon name={errors ? 'error' : 'warn'} size={16} />
        <strong>{errors ? `${errors} 个错误需要修正后才能写入` : `${warnings} 条提示（不影响写入）`}</strong>
        {errors > 0 && warnings > 0 && <span className="muted">另有 {warnings} 条提示</span>}
        <Icon name={open ? 'up' : 'down'} size={14} />
      </button>
      {open && (
        <ul className="issues-list" id={listId}>
          {sortIssues(issues).map((issue, i) => {
            const t = issueTarget(issue.path)
            return (
              <li key={i} className={`issue issue-${issue.severity}`}>
                <Icon name={issue.severity === 'error' ? 'error' : 'warn'} size={14} />
                {t ? (
                  <button type="button" className="link" onClick={() => onSelect(t.layer, t.keyId)}>
                    {issueWhere(issue.path)}
                  </button>
                ) : (
                  <span className="issue-where">{issueWhere(issue.path)}</span>
                )}
                <span>{issueMessageZh(issue.message)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
