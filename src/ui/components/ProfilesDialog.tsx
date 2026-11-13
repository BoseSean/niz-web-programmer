import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { FACTORY } from '../../device/layout'
import { profileToTable } from '../../format/compile'
import { normalizeProfile, parseProfileJson } from '../../format/normalize'
import type { NormalizedProfile } from '../../format/types'
import { diffTables } from '../../protocol/codec'
import { formatSavedAt } from '../lib/describe'
import { downloadText, stampedName } from '../lib/files'
import type { Draft } from '../state/editor'
import { BACKUP_LIMIT, getLocalStore, SIM_BACKUP_LIMIT, StoreError, type Backup, type LocalStore, type SavedProfile } from '../state/localStore'
import { Dialog } from './Dialog'
import { Icon } from './Icon'
import './library.css'

export type ProfilesTab = 'profiles' | 'backups'

export interface ProfilesDialogProps {
  open: boolean
  onClose: () => void
  /** The keys on the page ("把页面上的键位保存为方案" saves these). */
  current: Draft
  /** 载入到页面: replace the keys on the page with this profile (undoable). The dialog closes afterwards. */
  onLoad: (profile: NormalizedProfile, record: SavedProfile) => void
  /** 载入到页面: replace the keys on the page with this backup (undoable); nothing is written to the keyboard. */
  onRestoreBackup: (profile: NormalizedProfile, backup: Backup) => void
  /** Store to use; default the app-wide getLocalStore(). */
  store?: LocalStore | Promise<LocalStore>
  initialTab?: ProfilesTab
}

/** File-name-safe version of a profile name. */
const fileStem = (name: string) => name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || '84ec-s'

const errText = (e: unknown) => (e instanceof StoreError || e instanceof Error ? e.message : String(e))

const KIND_NOTE: Record<LocalStore['kind'], string | null> = {
  indexeddb: null,
  localstorage: null,
  memory: '浏览器不允许本地存储，方案和自动备份只保存在当前页面，刷新或关闭后会丢失。请用“导出 .json”保存成文件。',
}

/** How many slots of a backup differ from the factory map; null when its JSON no longer validates. */
function factoryDiff(json: string): number | null {
  try {
    const { profile } = parseProfileJson(json)
    return profile ? diffTables(FACTORY, profileToTable(profile)).length : null
  } catch {
    return null
  }
}

function useStore(store: ProfilesDialogProps['store'], open: boolean) {
  const [s, setS] = useState<LocalStore | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    if (!open || s) return
    let alive = true
    Promise.resolve(store ?? getLocalStore()).then(
      (x) => alive && setS(x),
      (e: unknown) => alive && setFailed(errText(e)),
    )
    return () => {
      alive = false
    }
  }, [open, s, store])
  return { store: s, failed }
}

/** Two-step delete button: the first press asks, the second deletes (deleting is not undoable). */
function DeleteButton({ label, onDelete }: { label: string; onDelete: () => void }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  return armed ? (
    <button type="button" className="btn btn-sm btn-danger" autoFocus onClick={onDelete} onBlur={() => setArmed(false)} aria-label={`确认删除${label}`}>
      确认删除
    </button>
  ) : (
    <button type="button" className="icon-btn" aria-label={`删除${label}`} title="删除（不可撤销）" onClick={() => setArmed(true)}>
      <Icon name="trash" />
    </button>
  )
}

function ProfileRow({
  rec,
  onLoad,
  onRename,
  onExport,
  onDelete,
}: {
  rec: SavedProfile
  onLoad: () => void
  onRename: (name: string) => Promise<boolean>
  onExport: () => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const renameBtn = useRef<HTMLButtonElement>(null)
  /** Set by Enter / Escape in the name field: focus goes back to 重命名 once the field is gone. */
  const refocus = useRef(false)
  useEffect(() => {
    if (editing === null && refocus.current) {
      refocus.current = false
      renameBtn.current?.focus()
    }
  }, [editing])
  const commit = async () => {
    if (editing === null) return
    const name = editing.trim()
    if (!name || name === rec.name) return setEditing(null)
    if (await onRename(name)) setEditing(null)
    else refocus.current = false
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      refocus.current = true
      void commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      refocus.current = true
      setEditing(null)
    }
  }
  return (
    <li className="pf-item">
      <div className="pf-main">
        {editing !== null ? (
          <input
            className="lib-rename"
            value={editing}
            maxLength={60}
            aria-label={`方案“${rec.name}”的新名称`}
            autoFocus
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={onKey}
            onBlur={() => void commit()}
          />
        ) : (
          <span className="pf-name">{rec.name}</span>
        )}
        <time className="pf-time mono" dateTime={new Date(rec.savedAt).toISOString()}>
          {formatSavedAt(rec.savedAt)}
        </time>
      </div>
      <div className="pf-tools">
        <button type="button" className="btn btn-sm btn-ink" onClick={onLoad} aria-label={`载入方案“${rec.name}”到页面`}>
          载入到页面
        </button>
        <button type="button" ref={renameBtn} className="btn btn-sm btn-ghost" onClick={() => setEditing(rec.name)} aria-label={`重命名方案“${rec.name}”`}>
          重命名
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onExport} aria-label={`导出方案“${rec.name}”`}>
          导出 .json
        </button>
        <DeleteButton label={`方案“${rec.name}”`} onDelete={onDelete} />
      </div>
    </li>
  )
}

/** 方案: named profiles saved in this browser (已保存的方案), and the automatic backups taken before each write (自动备份). */
export function ProfilesDialog({ open, onClose, current, onLoad, onRestoreBackup, store: storeProp, initialTab = 'profiles' }: ProfilesDialogProps) {
  const { store, failed } = useStore(storeProp, open)
  const [tab, setTab] = useState<ProfilesTab>(initialTab)
  const [profiles, setProfiles] = useState<SavedProfile[] | null>(null)
  const [backups, setBackups] = useState<Backup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [name, setName] = useState(current.name ?? '')
  const tabIds = { profiles: useId(), backups: useId() }
  const panelId = useId()
  const nameId = useId()
  const tabRefs = useRef<Record<ProfilesTab, HTMLButtonElement | null>>({ profiles: null, backups: null })

  const refresh = useCallback(
    (s: LocalStore) =>
      Promise.all([s.listProfiles(), s.listBackups()]).then(
        ([p, b]) => {
          setProfiles(p)
          setBackups(b)
        },
        (e: unknown) => setError(errText(e)),
      ),
    [],
  )
  useEffect(() => {
    if (!open || !store) return
    let alive = true
    Promise.all([store.listProfiles(), store.listBackups()]).then(
      ([p, b]) => {
        if (!alive) return
        setProfiles(p)
        setBackups(b)
      },
      (e: unknown) => alive && setError(errText(e)),
    )
    return () => {
      alive = false
    }
  }, [open, store])

  const errors = useMemo(() => normalizeProfile(current).issues.filter((i) => i.severity === 'error').length, [current])
  /** The newest backup of each target (keyboard, simulator) gets 最近一次. */
  const latest = useMemo(() => {
    const seen = new Map<Backup['target'], string>()
    for (const b of backups ?? []) if (!seen.has(b.target)) seen.set(b.target, b.id)
    return new Set(seen.values())
  }, [backups])
  const diffs = useMemo(() => new Map((backups ?? []).map((b) => [b.id, factoryDiff(b.profileJson)])), [backups])
  if (!open) return null

  const trimmed = name.trim()
  const same = profiles?.find((p) => p.name === trimmed)
  const run = async (fn: (s: LocalStore) => Promise<unknown>, ok?: string): Promise<boolean> => {
    if (!store) return false
    setError(null)
    setStatus(null)
    try {
      await fn(store)
      if (ok) setStatus(ok)
      await refresh(store)
      return true
    } catch (e) {
      setError(errText(e))
      return false
    }
  }

  /** The deleted row takes the focused button with it: keep focus in the dialog, on the current tab. */
  const remove = async (fn: (s: LocalStore) => Promise<unknown>, ok: string) => {
    if (await run(fn, ok)) tabRefs.current[tab]?.focus()
  }

  const save = () => {
    const { profile } = normalizeProfile(current)
    if (!profile || !trimmed) return
    void run((s) => s.saveProfile(trimmed, { ...profile, name: trimmed }, same?.id), same ? `已覆盖方案“${trimmed}”` : `已保存方案“${trimmed}”`)
  }

  const load = (rec: SavedProfile) =>
    void run(async (s) => {
      const res = await s.loadProfile(rec.id)
      if (!res.profile) throw new StoreError('invalid', `方案“${rec.name}”的内容无法通过校验，不能载入到页面（可以先导出后检查）`)
      onLoad(res.profile, res.record)
      onClose()
    })

  const restore = (b: Backup) =>
    void run(async (s) => {
      const res = await s.restoreBackup(b.id)
      if (!res.profile) throw new StoreError('invalid', '这份备份的内容无法通过校验，不能载入到页面（可以先导出后检查）')
      onRestoreBackup(res.profile, res.record)
      onClose()
    })

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const next: ProfilesTab = e.key === 'Home' ? 'profiles' : e.key === 'End' ? 'backups' : tab === 'profiles' ? 'backups' : 'profiles'
    setTab(next)
    tabRefs.current[next]?.focus()
  }

  const tabButton = (t: ProfilesTab, label: ReactNode) => (
    <button
      type="button"
      role="tab"
      id={tabIds[t]}
      ref={(el) => {
        tabRefs.current[t] = el
      }}
      aria-selected={tab === t}
      aria-controls={panelId}
      tabIndex={tab === t ? 0 : -1}
      className={tab === t ? 'is-on' : undefined}
      onClick={() => setTab(t)}
      onKeyDown={onTabKey}
    >
      {label}
    </button>
  )

  const kindNote = store ? KIND_NOTE[store.kind] : null

  return (
    <Dialog title="方案" onClose={onClose} wide footer={<button type="button" className="btn btn-ghost" onClick={onClose}>关闭</button>}>
      <div className="pf-tabs" role="tablist" aria-label="方案">
        {tabButton('profiles', <>已保存的方案{profiles && profiles.length > 0 && <span className="lib-count">{profiles.length}</span>}</>)}
        {tabButton('backups', <>自动备份{backups && backups.length > 0 && <span className="lib-count">{backups.length}</span>}</>)}
      </div>

      {kindNote && <p className="note note-warn pf-note">{kindNote}</p>}
      {store?.problems.filter((p) => !(kindNote && /刷新后会丢失/.test(p))).map((p) => (
        <p key={p} className="note pf-note">{p}</p>
      ))}
      {failed && <p className="pf-error" role="alert">无法打开本地存储：{failed}</p>}
      {error && <p className="pf-error" role="alert">{error}</p>}
      <p className="pf-status" role="status" aria-live="polite">{status}</p>

      <div role="tabpanel" id={panelId} aria-labelledby={tabIds[tab]} className="pf-panel">
        {tab === 'profiles' ? (
          <>
            <form
              className="pf-save"
              onSubmit={(e) => {
                e.preventDefault()
                save()
              }}
            >
              <label htmlFor={nameId} className="field-label">把页面上的键位保存为方案</label>
              <div className="pf-save-row">
                <input
                  id={nameId}
                  className="pf-input"
                  value={name}
                  maxLength={60}
                  placeholder="方案名称，例如：办公 / 游戏"
                  onChange={(e) => setName(e.target.value)}
                />
                <button type="submit" className="btn btn-sm btn-ink" disabled={!store || !trimmed || errors > 0}>
                  <Icon name="plus" />
                  {same ? '覆盖同名方案' : '保存'}
                </button>
              </div>
              {errors > 0 ? (
                <p className="field-hint pf-warn">页面上的键位有 {errors} 个错误，改正后才能保存为方案。</p>
              ) : same ? (
                <p className="field-hint">已经有叫“{same.name}”的方案（{formatSavedAt(same.savedAt)}），保存会覆盖它。</p>
              ) : (
                <p className="field-hint">方案保存在这个浏览器里，包括两层键位和动作库；不会自动写入键盘。</p>
              )}
            </form>

            {profiles === null ? (
              <p className="muted">正在读取…</p>
            ) : profiles.length === 0 ? (
              <div className="pf-empty">
                <p>还没有保存的方案。</p>
                <p className="muted">把常用的键位保存成方案，就可以随时在几套键位之间切换：载入到页面，再点“写入键盘”。</p>
              </div>
            ) : (
              <ul className="pf-list" aria-label="已保存的方案">
                {profiles.map((rec) => (
                  <ProfileRow
                    key={rec.id}
                    rec={rec}
                    onLoad={() => load(rec)}
                    onRename={(n) => run((s) => s.renameProfile(rec.id, n), `已重命名为“${n}”`)}
                    onExport={() => downloadText(stampedName(fileStem(rec.name), 'json'), rec.profileJson, 'application/json')}
                    onDelete={() => void remove((s) => s.deleteProfile(rec.id), `已删除方案“${rec.name}”`)}
                  />
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <p className="lead">
              每次写入前，键盘里原来的键位会自动备份到这里（保留最近 {BACKUP_LIMIT} 份；模拟键盘另存 {SIM_BACKUP_LIMIT} 份）。载入后还要点“写入键盘”才会写回键盘。
            </p>
            {backups === null ? (
              <p className="muted">正在读取…</p>
            ) : backups.length === 0 ? (
              <div className="pf-empty">
                <p>还没有自动备份。</p>
                <p className="muted">每次点“写入键盘”，都会先在这里自动备份键盘里原来的键位。</p>
              </div>
            ) : (
              <ul className="pf-list" aria-label="自动备份">
                {backups.map((b) => {
                  const when = formatSavedAt(b.savedAt)
                  const diff = diffs.get(b.id) ?? null
                  return (
                    <li key={b.id} className="pf-item">
                      <div className="pf-main">
                        <time className="pf-name mono" dateTime={new Date(b.savedAt).toISOString()}>{when}</time>
                        <span className="pf-time">
                          写入之前
                          {diff !== null && ` · ${diff ? `${diff} 处与出厂不同` : '出厂键位'}`}
                          {latest.has(b.id) && <span className="badge badge-ink pf-badge">最近一次</span>}
                          {b.target === 'simulator' && <span className="badge pf-badge">模拟键盘</span>}
                        </span>
                      </div>
                      <div className="pf-tools">
                        <button type="button" className="btn btn-sm btn-ink" onClick={() => restore(b)} aria-label={`载入 ${when} 的备份到页面`}>
                          <Icon name="restore" />
                          载入到页面
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          aria-label={`导出 ${when} 的备份`}
                          onClick={() => downloadText(stampedName('84ec-s-backup', 'json', new Date(b.savedAt)), b.profileJson, 'application/json')}
                        >
                          导出 .json
                        </button>
                        <DeleteButton label={` ${when} 的备份`} onDelete={() => void remove((s) => s.deleteBackup(b.id), '已删除备份')} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
