import { useId, useRef, type ChangeEvent } from 'react'
import { useMenu } from '../lib/useMenu'
import { Icon } from './Icon'
import type { ProfilesTab } from './ProfilesDialog'
import './PlanMenu.css'

interface Props {
  /** Opens the 方案 dialog on one of its tabs. */
  onOpenProfiles: (tab: ProfilesTab) => void
  /** true: both layers in full; false: only the keys that differ from the factory map. */
  onExportJson: (full: boolean) => void
  onExportPro: () => void
  /** The picked .json or KB84 .pro file (App tells them apart by the extension). */
  onImportFile: (file: File) => void
}

function MenuItem({ label, hint, close, onSelect }: { label: string; hint: string; close: () => void; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={() => {
        close()
        onSelect()
      }}
    >
      <span>{label}</span>
      <small>{hint}</small>
    </button>
  )
}

/**
 * 方案 menu: the profiles and automatic backups kept in this browser, and file export / import (one input for both
 * .json and .pro). Keyboard: opening focuses the first item, ↑ ↓ Home End move, Esc closes; focus returns to the 方案
 * button (so a dialog opened from the menu gives focus back to it when it closes).
 */
export function PlanMenu({ onOpenProfiles, onExportJson, onExportPro, onImportFile }: Props) {
  const { open, setOpen, root, trigger, pop, close, onMenuKey, onTriggerKey } = useMenu()
  const input = useRef<HTMLInputElement>(null)
  const plansId = useId()
  const filesId = useId()

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) onImportFile(f)
  }

  return (
    <div className="menu" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="btn btn-ghost"
        aria-label="方案"
        title="方案：存在浏览器里的方案和自动备份，导出导入文件"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={onTriggerKey}
      >
        <Icon name="archive" />
        <span className="btn-label">方案</span>
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className="menu-pop plan-pop" role="menu" aria-label="方案" ref={pop} onKeyDown={onMenuKey}>
          <div role="group" aria-labelledby={plansId}>
            <div className="menu-group" id={plansId} role="presentation">方案（存在这个浏览器里）</div>
            <MenuItem label="已保存的方案…" hint="把页面上的键位和动作库存为方案，或载入以前存的" close={close} onSelect={() => onOpenProfiles('profiles')} />
            <MenuItem label="自动备份…" hint="每次写入前自动保存的键盘里的键位" close={close} onSelect={() => onOpenProfiles('backups')} />
          </div>
          <div role="group" aria-labelledby={filesId}>
            <div className="menu-group" id={filesId} role="presentation">文件</div>
            <MenuItem label="导出 JSON（完整）" hint="两层全部键位和动作库" close={close} onSelect={() => onExportJson(true)} />
            <MenuItem label="导出 JSON（只含改动）" hint="只写出与出厂不同的键" close={close} onSelect={() => onExportJson(false)} />
            <MenuItem label="导出 KB84 .pro" hint="可在原厂软件中打开" close={close} onSelect={onExportPro} />
            <MenuItem label="导入文件…" hint=".json 或 KB84 .pro，也可以直接拖到页面上" close={close} onSelect={() => input.current?.click()} />
          </div>
        </div>
      )}
      <input ref={input} type="file" accept=".json,.pro,application/json" hidden onChange={pick} data-testid="import-file" />
    </div>
  )
}
