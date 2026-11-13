import { useId, useMemo, useState } from 'react'
import { keyById } from '../../device/layout'
import { LAYER_ZH } from '../lib/describe'
import { clearAllDraft, type ClearResult } from '../lib/clearAll'
import type { Draft } from '../state/editor'
import { Dialog } from './Dialog'
import { Icon } from './Icon'

interface Props {
  draft: Draft
  onClose: () => void
  /** The cleared draft and whether Fn / the mode switch were cleared too. */
  onConfirm: (result: ClearResult, keepFn: boolean) => void
}

/** 全部清空: confirm dialog; Fn and the 办公/编程模式切换 survive unless the box is ticked. */
export function ClearAllDialog({ draft, onClose, onConfirm }: Props) {
  const [clearFn, setClearFn] = useState(false)
  const warnId = useId()
  const preview = useMemo(() => clearAllDraft(draft, { keepFn: true }), [draft])

  return (
    <Dialog
      title="全部清空"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            type="button"
            className={`btn ${clearFn ? 'btn-primary' : 'btn-ink'}`}
            onClick={() => onConfirm(clearAllDraft(draft, { keepFn: !clearFn }), !clearFn)}
          >
            <Icon name="eraser" />
            {clearFn ? '全部清空（含 Fn）' : '全部清空'}
          </button>
        </>
      }
    >
      <p className="lead">把两层所有键位设为“无”。只改页面上的键位，写入后才生效；可以按 Ctrl+Z 撤销。动作库不变。</p>
      {!clearFn && (
        <p className="clear-kept">
          保留：
          {preview.kept.map((k, i) => (
            <span key={`${k.layer}/${k.keyId}`}>
              {i > 0 && '、'}
              <b>{LAYER_ZH[k.layer]} · {keyById(k.keyId)?.label ?? k.keyId}</b>（{k.what === 'fn' ? 'Fn' : '办公/编程模式切换'}）
            </span>
          ))}
        </p>
      )}
      <label className="check-row">
        <input type="checkbox" checked={clearFn} onChange={(e) => setClearFn(e.currentTarget.checked)} aria-describedby={clearFn ? warnId : undefined} />
        <span>连 Fn 和模式切换也清空</span>
      </label>
      {clearFn && (
        <p className="clear-warn" id={warnId} role="alert">
          <Icon name="warn" size={16} />
          <span>
            写入后将<b>无法进入 Fn 层</b>，也<b>无法切换办公/编程模式</b>。只能用键盘复位恢复：同时按住 <kbd>Esc</kbd> + <kbd>Delete</kbd> + <kbd>左 Ctrl</kbd> + <kbd>→</kbd> 约 5 秒。
          </span>
        </p>
      )}
    </Dialog>
  )
}
