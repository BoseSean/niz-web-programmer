import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { resolveCodeRef } from './device/codes'
import { FACTORY, keyById, KEYS } from './device/layout'
import type { LayerId } from './device/types'
import { tableToProfile } from './format/compile'
import { parseProfileJson } from './format/normalize'
import { serializeProfile } from './format/serialize'
import type { Action, FormatIssue, NormalizedProfile } from './format/types'
import { parseProFile } from './kb84/pro'
import { diffTables, slotsEqual } from './protocol/codec'
import type { SessionReadResult } from './protocol/session'
import type { SlotTable } from './protocol/slots'
import { BulkMenu } from './ui/components/BulkMenu'
import { ClearAllDialog } from './ui/components/ClearAllDialog'
import { ConnectionBar, type ModeHint } from './ui/components/ConnectionBar'
import { Dialog } from './ui/components/Dialog'
import { HelpPanel } from './ui/components/HelpPanel'
import { Icon } from './ui/components/Icon'
import { Inspector } from './ui/components/Inspector'
import { IssuesPanel } from './ui/components/IssuesPanel'
import { KeyTesterPanel } from './ui/components/KeyTester'
import { LibraryPanel } from './ui/components/LibraryPanel'
import { Notices, type Notice, type NoticeAction, type NoticeTopic, type Tone } from './ui/components/Notices'
import { PacketLogDrawer } from './ui/components/PacketLog'
import { PlanMenu } from './ui/components/PlanMenu'
import { ProfilesDialog, type ProfilesTab } from './ui/components/ProfilesDialog'
import { Segmented } from './ui/components/Segmented'
import { SyncStatus } from './ui/components/SyncStatus'
import { WriteDialog, type WriteOutcome, type WriteStage } from './ui/components/WriteDialog'
import { KeyboardView } from './ui/KeyboardView'
import { changeRows, type ChangeRow } from './ui/lib/changes'
import { LAYER_ZH } from './ui/lib/describe'
import { buildFaces } from './ui/lib/faces'
import { downloadText, exportPro, fileKind, stampedName, type ProBlocker } from './ui/lib/files'
import { issueMessageZh, issueWhere, sortIssues } from './ui/lib/issues'
import { isTypingTarget } from './ui/lib/useKeyCapture'
import { derive, editorReducer, HISTORY_LIMIT, initialEditorState, keyRef, type Draft } from './ui/state/editor'
import { libraryCount } from './ui/state/library'
import { getLocalStore, type LocalStore } from './ui/state/localStore'
import { PacketLog } from './ui/state/packetLog'
import { DeviceError, joinSentences, useDevice, type DeviceOptions } from './ui/state/useDevice'
import './ui/app.css'

const PROGRAM_MODE = 159
/** Note of the backup taken automatically before every keyboard write. */
const PRE_WRITE_BACKUP_NOTE = '写入前自动备份'
/** A write never waits longer than this for the local store (a hung IndexedDB must not block writing). */
const BACKUP_TIMEOUT_MS = 5000
/** ok / info notices close on their own after this long (and on the next edit). */
const NOTICE_MS = 6000
/** Room kept between the sticky toolbar and the right column scrolled up under it (narrow windows). */
const SCROLL_GAP = 8
/** Notices kept at once (the stack shows the newest two). */
const NOTICE_LIMIT = 3
/** Whether the 通信日志 drawer is shown (toggled in 使用说明). */
const LOG_KEY = 'plum.showLog'

/** Right column: the key inspector, or one of the tools that replace it while open. */
type Side = 'inspector' | 'library' | 'tester'
const SIDE_LABEL: Record<Side, string> = { inspector: '键位设置', library: '动作库', tester: '按键测试' }

interface WriteBackup {
  savedAt: number
  /** What was backed up: the last keyboard read, or a read taken just before the write (the keyboard was never read). */
  source: 'device' | 'pre-read'
  profile: NormalizedProfile
}

/** The last write of this page session: what was written and whether the read-back matched it. */
interface LastWrite {
  table: SlotTable
  verified: boolean
}

interface AppNotice extends Notice {
  /** The draft on the page when the notice appeared: an ok / info notice closes once the page changes. */
  born: Draft
  /** The draft the reported change replaced; the notice belongs to that undo entry (and offers 撤销 while it is on top). */
  change?: Draft
  /** The draft that change produced: 撤销 is offered only while it is still the page (not a later edit's copy). */
  result?: Draft
  undoable?: boolean
}

interface NotifyOptions {
  topic?: NoticeTopic
  sticky?: boolean
  /** The draft before the change this notice reports (pass it whenever the same handler replaced the draft). */
  change?: Draft
  /** Offer 撤销 for that change, which put `result` on the page. */
  undo?: Draft
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('浏览器本地存储没有响应')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

const p2 = (n: number) => String(n).padStart(2, '0')
const hhmm = (d = new Date()) => `${p2(d.getHours())}:${p2(d.getMinutes())}`
const shortWhen = (ms: number) => {
  const d = new Date(ms)
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hhmm(d)}`
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** An error's message, with the browser's own text (DeviceError.detail) folded under 详情. */
function errorBody(e: unknown): ReactNode {
  const detail = e instanceof DeviceError ? e.detail : undefined
  if (!detail) return errText(e)
  return (
    <>
      {errText(e)}
      <details className="notice-detail">
        <summary>详情</summary>
        <span className="mono">{detail}</span>
      </details>
    </>
  )
}

const missingOf = (seen: { base: boolean[]; fn: boolean[] }) => seen.base.filter((x) => !x).length + seen.fn.filter((x) => !x).length
const isCustom = (t: SlotTable | null | undefined): t is SlotTable => !!t && diffTables(t, FACTORY).length > 0

/** Every slot the read did receive is the factory map's: what Office mode reads (a dropped packet does not hide that). */
const receivedFactory = ({ table, seen }: SessionReadResult) =>
  (['base', 'fn'] as const).every((l) => table[l].every((slot, i) => !seen[l][i] || slotsEqual(slot, FACTORY[l][i])))

/** The page with the keys an incomplete read received; the others keep their page value (never turned into 无 unseen). */
function withReceived(page: Draft, { table, seen }: SessionReadResult): Draft {
  const read = tableToProfile(table).layers
  const layers = { base: { ...page.layers.base }, fn: { ...page.layers.fn } }
  for (const l of ['base', 'fn'] as const)
    KEYS.forEach((k, i) => {
      if (seen[l][i]) layers[l][k.id] = read[l][k.id]
    })
  return { ...page, layers }
}

/**
 * Mode of a real keyboard after a complete read. A factory read after a known custom bank means Office mode (the
 * caller then keeps the page); otherwise only the user's own word (program), given after a factory read, beats the
 * doubt.
 */
function modeAfterRead(matchesFactory: boolean, knownCustom: boolean, current: ModeHint): ModeHint {
  if (!matchesFactory) return 'program'
  if (knownCustom) return 'office'
  return current === 'program' ? 'program' : 'maybe-office'
}

/** What the leave prompt compares: the 动作库 lives only on the page (it is never written to the keyboard). */
const libraryKey = (d: Draft) => (libraryCount(d) > 0 ? JSON.stringify(d.library) : '')

/** Undo labels that bring a whole key map onto the page, and what 「页面上：…」 then says (null: an ordinary edit). */
const READ_LABEL = '读取键盘 '
function sourceOf(label: string): string | null {
  if (label.startsWith(READ_LABEL)) return `读取的键盘 ${label.slice(READ_LABEL.length)}`
  if (label.startsWith('载入方案')) return label.slice(2)
  if (label.startsWith('载入自动备份 ')) return label.slice(2)
  if (label.startsWith('导入 ')) return label
  if (label === '改回写入前的键位') return '写入前的键位'
  if (label === '全部改回出厂键位') return '出厂键位'
  return null
}

function readLogVisible(): boolean {
  try {
    return localStorage.getItem(LOG_KEY) === '1'
  } catch {
    return false
  }
}

interface Confirm {
  title: string
  body: ReactNode
  confirmLabel: string
  onConfirm: () => void
}

function IssueList({ issues, max = 8 }: { issues: FormatIssue[]; max?: number }) {
  const sorted = sortIssues(issues)
  return (
    <ul className="notice-list">
      {sorted.slice(0, max).map((i, n) => (
        <li key={n}>
          <b>{issueWhere(i.path)}</b>：{issueMessageZh(i.message)}
        </li>
      ))}
      {sorted.length > max && <li>……以及另外 {sorted.length - max} 条</li>}
    </ul>
  )
}

/** The packets a read skipped, folded into the read's notice. */
function ReadWarnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null
  return (
    <details className="notice-detail">
      <summary>读取时忽略了 {warnings.length} 个异常数据包</summary>
      <ul className="notice-list mono">{warnings.slice(0, 6).map((w, i) => <li key={i}>{w}</li>)}</ul>
    </details>
  )
}

type StepState = 'is-done' | 'is-current' | 'todo'

/** One line of the 从这里开始 checklist; the current step carries its own next action (and takes focus without one). */
function Step({ state, title, sub, children }: { state: StepState; title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <li className={state} aria-current={state === 'is-current' ? 'step' : undefined} tabIndex={state === 'is-current' ? -1 : undefined}>
      <span>
        {state === 'is-done' && <span className="sr-only">已完成：</span>}
        <b>{title}</b>
        {sub && <span className="step-sub">{sub}</span>}
        {children && <span className="step-do">{children}</span>}
      </span>
    </li>
  )
}

/**
 * Replaces only the key map (a keyboard read, a backup, the factory map): name, description, library and backlight
 * all stay those of the draft. A backup's own name ("写入前自动备份") is never adopted as the profile name.
 */
const withMeta = (layersFrom: NormalizedProfile, meta: Draft): Draft => ({ ...meta, layers: layersFrom.layers })

/** 「动作库也换成了…」 when a profile or file brings another library over a non-empty one. */
const libraryNote = (before: Draft, after: Draft, from: string) =>
  libraryCount(before) > 0 && JSON.stringify(before.library ?? null) !== JSON.stringify(after.library ?? null)
    ? `动作库也换成了${from}里的（可撤销）。`
    : null

export interface AppProps {
  deviceOptions?: DeviceOptions
  /** Local store for saved profiles and backups; default the app-wide getLocalStore(). */
  store?: LocalStore | Promise<LocalStore>
}

export default function App({ deviceOptions, store }: AppProps = {}) {
  const [log] = useState(() => new PacketLog())
  const [ed, dispatch] = useReducer(editorReducer, undefined, () => initialEditorState())
  const derived = useMemo(() => derive(ed.present, ed.device), [ed.present, ed.device])
  const [notices, setNotices] = useState<AppNotice[]>([])
  const [writeStage, setWriteStage] = useState<WriteStage | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [proBlockers, setProBlockers] = useState<{ blockers: ProBlocker[]; text: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [side, setSide] = useState<Side>('inspector')
  const [testerKeys, setTesterKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [profilesOpen, setProfilesOpen] = useState(false)
  const [profilesTab, setProfilesTab] = useState<ProfilesTab>('profiles')
  const [clearOpen, setClearOpen] = useState(false)
  const [writeBackup, setWriteBackup] = useState<WriteBackup | null>(null)
  const [backupFailed, setBackupFailed] = useState(false)
  const [preReadFailed, setPreReadFailed] = useState(false)
  /** Why the read before the confirmation failed, when the dialog still shows what was known before it. */
  const [rereadError, setRereadError] = useState<string | null>(null)
  /** What the last write changed, for 试试刚改的键 (kept for 再写一次). */
  const [written, setWritten] = useState<ChangeRow[]>([])
  const [lastWrite, setLastWrite] = useState<LastWrite | null>(null)
  /** A real keyboard's mode as far as the page can tell (the simulator says its own). */
  const [modeHint, setModeHint] = useState<ModeHint>('unknown')
  /** Step ② was ticked (亮着) before any read: it only moves the checklist on, it is no evidence of the mode. */
  const [mlightTicked, setMlightTicked] = useState(false)
  /** An Office-mode write that was not verified yet (重新校验 stays offered after 稍后). */
  const [pendingVerify, setPendingVerify] = useState(false)
  /**
   * What is on the keyboard is unknown (a write broke off, a read came back incomplete): ed.device may not be it, so
   * the next write reads it first.
   */
  const [deviceStale, setDeviceStale] = useState(false)
  /** The keyboard reconnected and was not read since: it may have changed meanwhile, so the next write reads it first. */
  const [linkUnread, setLinkUnread] = useState(false)
  /** The library as last kept (loaded, imported, exported or saved as a 方案): leaving with another one asks first. */
  const [keptLibrary, setKeptLibrary] = useState('')
  const [issuesRequest, setIssuesRequest] = useState(0)
  const [logVisible, setLogVisible] = useState(readLogVisible)
  const toolbar = useRef<HTMLElement>(null)
  const sideTabs = useRef<HTMLDivElement>(null)
  const focusSideTab = useRef(false)
  /** Bumped by 取消 while preparing (and by an unplug): the read that was running no longer opens the confirmation. */
  const prepareSeq = useRef(0)
  /** Bumped on every unplug: a write that sees it change before sending knows nothing reached the keyboard. */
  const unplugs = useRef(0)
  /** The result on screen came from 重新校验, not from a write of the page as it is now. */
  const reverified = useRef(false)
  /** Latest draft, for async flows and notice actions that outlive the render that created them. */
  const presentRef = useRef(ed.present)
  useEffect(() => {
    presentRef.current = ed.present
  })
  const noticeSeq = useRef(0)

  const dismiss = useCallback((id: number) => setNotices((l) => l.filter((n) => n.id !== id)), [])
  const dismissTopic = useCallback((topic: NoticeTopic) => setNotices((l) => l.filter((n) => n.topic !== topic)), [])

  /** A new notice replaces the one of the same topic; ok / info ones close by themselves after NOTICE_MS. */
  const notify = useCallback(
    (tone: Tone, title: string, body?: ReactNode, actions?: NoticeAction[], opts: NotifyOptions = {}) => {
      const id = ++noticeSeq.current
      // Every action closes its notice (重新读取 brings a fresh one).
      const acts = actions?.map((a) => ({
        label: a.label,
        onClick: () => {
          dismiss(id)
          a.onClick()
        },
      }))
      const timeout = (tone === 'ok' || tone === 'info') && !opts.sticky ? NOTICE_MS : undefined
      const n: AppNotice = {
        id,
        tone,
        title,
        body,
        actions: acts,
        topic: opts.topic,
        sticky: opts.sticky,
        timeout,
        born: presentRef.current,
        change: opts.change,
        result: opts.undo,
        undoable: !!opts.undo,
      }
      setNotices((list) => [n, ...list.filter((x) => !opts.topic || x.topic !== opts.topic)].slice(0, NOTICE_LIMIT))
      return id
    },
    [dismiss],
  )

  const device = useDevice(log, {
    ...deviceOptions,
    onUnplugged: () => {
      unplugs.current++
      // The confirmation (or the read before it) cannot go on: nothing was written.
      const open = writeStage?.stage === 'confirm' || writeStage?.stage === 'preparing'
      if (open) {
        prepareSeq.current++
        setWriteStage(null)
      }
      const auto = device.ui.granted && device.ui.autoConnect && !device.ui.autoPaused
      notify(
        'warn',
        open ? '键盘已断开，没有写入' : '键盘已断开',
        `${open ? '键盘里的键位没有改动。' : ''}页面上的修改还在（刷新页面会丢失）。${auto ? '重新插上会自动连接。' : '重新插上后点“连接键盘”。'}`,
        undefined,
        { topic: 'connection' },
      )
    },
    onAutoConnected: () => dismissTopic('connection'),
  })
  const busy = device.ui.busy
  const connected = device.ui.connected
  const sim = device.ui.kind === 'simulator'
  // The simulator knows its mode; a real keyboard's is inferred from reads and writes.
  const mode: ModeHint = sim ? (device.ui.simMode === 'office' ? 'office' : 'program') : modeHint

  // A new connection says nothing about the M light yet. Another keyboard (or the simulator, which starts afresh on
  // every connection) says nothing about the key map either: what the page knew belongs to the one before, so the
  // first write reads and backs up this one. The page itself stays.
  const link = connected ? `${device.ui.kind}/${device.ui.name}` : null
  const [seenLink, setSeenLink] = useState(link)
  const [lastLink, setLastLink] = useState<string | null>(null)
  if (link !== seenLink) {
    setSeenLink(link)
    if (link && (link !== lastLink || sim)) {
      setLastLink(link)
      dispatch({ type: 'setDevice', table: null })
      setLastWrite(null)
      setWriteBackup(null)
      setWritten([])
      setDeviceStale(false)
      setLinkUnread(false)
      setBackupFailed(false)
      setPendingVerify(false)
      setModeHint('unknown')
      setMlightTicked(false)
    } else if (link) {
      // The same keyboard again. A doubted M light stays doubted: a reconnect never proves Program mode.
      setLinkUnread(true)
      setMlightTicked(false)
      if (modeHint === 'program') setModeHint('unknown')
    }
  }

  /** [M 灯亮着] after a factory read: the user's word against the doubt. */
  const confirmProgram = () => {
    setModeHint('program')
    dismissTopic('read')
  }

  /** The last custom bank the page knows the keyboard held (read, or written): a factory read after it means Office mode. */
  const knownBank = isCustom(ed.device) ? ed.device : lastWrite && isCustom(lastWrite.table) ? lastWrite.table : null
  const knownCustom = knownBank !== null
  /** Office mode hides the custom bank: a read with nothing but factory slots after a known custom bank. */
  const readsOffice = (res: SessionReadResult) => knownCustom && receivedFactory(res) && (!sim || device.ui.simMode === 'office')
  /** The mode before a read, as modeAfterRead weighs it: a 'program' given while nothing was known proves nothing. */
  const hintBefore: ModeHint = ed.device || lastWrite ? modeHint : 'unknown'

  // --- reading ---------------------------------------------------------------------------------------------------
  /** Notice actions outlive their render: they call the latest handlers through this. */
  const latest = useRef({ requestRead: () => {}, acceptFactory: () => {} })
  const rereadAction: NoticeAction = { label: '重新读取', onClick: () => latest.current.requestRead() }

  /** `missing`: the read was incomplete, so it cannot be taken as the factory map either. */
  const officeReadNotice = (missing: number) =>
    notify(
      'warn',
      '页面上的键位保持不变',
      sim
        ? '读到的是出厂键位，但键盘里原来是你改过的键位：模拟键盘现在是办公模式（M 灯灭）。点 M 开关切到编程模式后点“重新读取”。'
        : joinSentences(
            '读到的是出厂键位，但键盘里原来是你改过的键位：键盘现在多半是办公模式（M 灯灭）。按住 Fn+F12 约 2 秒，灯亮后点“重新读取”',
            missing
              ? `这次还有 ${missing} 个键位没有收到`
              : 'M 灯亮着、键盘里确实是出厂键位（比如刚做过键盘复位）时，点“确实是出厂键位，载入”',
          ),
      sim || missing ? [rereadAction] : [rereadAction, { label: '确实是出厂键位，载入', onClick: () => latest.current.acceptFactory() }],
      { topic: 'read', sticky: true },
    )

  const doRead = async (): Promise<void> => {
    dismissTopic('read')
    try {
      const res = await device.read()
      const missing = missingOf(res.seen)
      if (readsOffice(res)) {
        // Office mode hides the custom bank: loading the factory map would invite overwriting the user's keys.
        if (!sim) setModeHint('office')
        if (!missing) setLinkUnread(false)
        officeReadNotice(missing)
        return
      }
      const before = presentRef.current
      const extra = <ReadWarnings warnings={res.warnings} />
      if (missing) {
        // Not the keyboard's table: what is on it stays unknown, and the next write reads it first. A known custom bank
        // is never replaced by part of one; otherwise the keys that came are put on the page.
        setDeviceStale(true)
        const draft = knownCustom ? null : withReceived(before, res)
        if (draft) dispatch({ type: 'replace', draft, label: `${READ_LABEL}${hhmm()}（不完整）` })
        notify(
          'warn',
          `读取不完整：有 ${missing} 个键位没有收到`,
          <>
            {draft ? '页面上换成了收到的键位，没收到的保持原样。' : '页面上的键位保持不变。'}
            写入前会先重新读取键盘。请重新插拔键盘后再读一次。{extra}
          </>,
          [rereadAction],
          { topic: 'read', change: draft ? before : undefined },
        )
        return
      }
      dispatch({ type: 'setDevice', table: res.table })
      dispatch({ type: 'replace', draft: withMeta(tableToProfile(res.table), before), label: `${READ_LABEL}${hhmm()}` })
      setDeviceStale(false)
      setLinkUnread(false)
      setPendingVerify(false)
      const next = sim ? mode : modeAfterRead(res.matchesFactory, knownCustom, hintBefore)
      if (!sim) setModeHint(next)
      if (next === 'maybe-office')
        notify(
          'info',
          '读到的是出厂键位',
          <>如果你改过键位，说明键盘在办公模式（M 灯灭）：按住 Fn+F12 约 2 秒，灯亮后重新读取。从没改过就直接开始修改。{extra}</>,
          [{ label: 'M 灯亮着，继续', onClick: () => setModeHint('program') }, rereadAction],
          { topic: 'read', sticky: true, change: before },
        )
      else if (sim && res.matchesFactory && next === 'office')
        notify('info', '读到的是出厂键位', <>模拟键盘现在是办公模式（M 灯灭），读不到键盘里的键位。点 M 开关切到编程模式后再读取。{extra}</>, undefined, { topic: 'read', change: before })
      else notify('ok', '已读取键盘', <>{res.matchesFactory && '键盘里的键位就是出厂键位。'}{extra}</>, undefined, { topic: 'read', change: before })
    } catch (e) {
      notify('error', '读取失败', errorBody(e), [rereadAction], { topic: 'read' })
    }
  }

  /**
   * Reads the keyboard for the write dialog only: the device table (and the mode) change, the page does not.
   * Null when it worked; otherwise why not, for the dialog.
   */
  const readDeviceOnly = async (): Promise<string | null> => {
    try {
      const res = await device.read()
      const missing = missingOf(res.seen)
      const office = readsOffice(res)
      if (office && !sim) setModeHint('office')
      if (missing) return `读取不完整：有 ${missing} 个键位没有收到。`
      setLinkUnread(false)
      setDeviceStale(false)
      if (office) {
        // The known custom bank stays the baseline (after a broken write too); the dialog warns about Office mode.
        if (ed.device !== knownBank) dispatch({ type: 'setDevice', table: knownBank })
        return null
      }
      dispatch({ type: 'setDevice', table: res.table })
      if (!sim) setModeHint(modeAfterRead(res.matchesFactory, knownCustom, hintBefore))
      return null
    } catch (e) {
      return errText(e)
    }
  }

  const unsaved = ed.device ? derived.pendingCount : ed.past.length > 0 ? derived.changedCount : 0
  const requestRead = () => {
    if (unsaved === 0) return void doRead()
    setConfirm({
      title: '读取键盘',
      body: `页面上有 ${unsaved} 处修改还没有写入键盘。读取后会用键盘里的键位替换它们（之后仍可按 Ctrl+Z 撤销）。`,
      confirmLabel: '读取并替换',
      onConfirm: () => void doRead(),
    })
  }

  /**
   * 确实是出厂键位，载入 (after an Office-looking read): the custom bank really is the factory map, e.g. after 键盘复位,
   * and the M light is on. The read is taken as it came, and the page with it.
   */
  const acceptFactory = () => {
    const load = () => {
      const before = presentRef.current
      const draft = withMeta(tableToProfile(FACTORY), before)
      dispatch({ type: 'setDevice', table: FACTORY })
      dispatch({ type: 'replace', draft, label: `${READ_LABEL}${hhmm()}` })
      setLastWrite(null)
      setDeviceStale(false)
      setLinkUnread(false)
      setPendingVerify(false)
      setModeHint('program')
      notify('ok', '已读取键盘', '键盘里的键位就是出厂键位，已载入到页面。', undefined, { topic: 'read', change: before, undo: draft })
    }
    if (unsaved === 0) return load()
    setConfirm({
      title: '载入出厂键位',
      body: `页面上有 ${unsaved} 处修改还没有写入键盘。载入后会用出厂键位替换它们（之后仍可按 Ctrl+Z 撤销）。`,
      confirmLabel: '载入并替换',
      onConfirm: load,
    })
  }
  useEffect(() => {
    latest.current = { requestRead, acceptFactory }
  })

  // --- writing ---------------------------------------------------------------------------------------------------
  /** The table the write dialog compares with: the keyboard's, unless it was never read or is unknown now. */
  const baselineTable = ed.device && !deviceStale ? ed.device : null

  /**
   * 写入键盘 (and 先重新读取键盘). A keyboard that was never read, whose table went stale, or that reconnected since, is
   * read first ('preparing'), so the confirmation lists what really changes on it and the pre-write backup holds what
   * is on it. If that read fails, the dialog still opens, says so, and compares with what was known before (the factory
   * map when nothing was). 取消 closes it; the read may still finish.
   */
  const prepareWrite = async (force = false): Promise<void> => {
    setPreReadFailed(false)
    setRereadError(null)
    if (baselineTable && !linkUnread && !force) return void setWriteStage({ stage: 'confirm' })
    const token = ++prepareSeq.current
    setWriteStage({ stage: 'preparing' })
    const err = await readDeviceOnly()
    if (prepareSeq.current !== token) return
    setPreReadFailed(err !== null)
    // With a table read before, the dialog would otherwise look as if this read had worked.
    setRereadError(ed.device ? err : null)
    setWriteStage({ stage: 'confirm' })
  }
  const cancelPrepare = () => {
    prepareSeq.current++
    setWriteStage(null)
  }

  const writeChanges = useMemo(
    () => (writeStage?.stage === 'confirm' && derived.table ? changeRows(baselineTable ?? FACTORY, derived.table) : []),
    [baselineTable, derived.table, writeStage],
  )
  const cautions = useMemo(() => {
    const out: string[] = []
    const f12 = ed.present.layers.fn.f12
    if (!(f12?.type === 'key' && resolveCodeRef(f12.code)?.value === PROGRAM_MODE))
      out.push('Fn 层的 F12 不再是“办公/编程模式切换”。如果切换功能依赖这个键位，写入后可能无法再切换模式。')
    return out
  }, [ed.present])
  const writtenIsFactory = derived.table ? !isCustom(derived.table) : false
  // 'office': the keyboard holds a custom bank the last read could not see; 'uncertain': the keyboard was read as the
  // factory map and nothing says the M light was on.
  const modeWarning = sim
    ? false
    : modeHint === 'office'
      ? 'office'
      : modeHint === 'maybe-office' || (modeHint === 'unknown' && !!baselineTable && !isCustom(baselineTable))
        ? 'uncertain'
        : false

  const finishWrite = (table: SlotTable, outcome: WriteOutcome, deviceTable: SlotTable | null) => {
    // An incomplete read-back is not the keyboard's table: what is on it stays unknown until a complete read.
    const unknown = outcome.kind === 'mismatch' && outcome.incomplete
    if (deviceTable && !unknown) dispatch({ type: 'setDevice', table: deviceTable })
    setDeviceStale(unknown)
    if (!unknown) setLinkUnread(false)
    setLastWrite({ table, verified: outcome.kind === 'verified' })
    setPendingVerify(outcome.kind === 'office')
    // A verified custom map can only be read back in Program mode; a factory one tells nothing.
    if (!sim && outcome.kind === 'verified' && isCustom(table)) setModeHint('program')
    if (!sim && outcome.kind === 'office') setModeHint('office')
    setWriteStage({ stage: 'result', outcome })
  }

  /**
   * Saves what the write is about to overwrite: the keyboard's table or, when that is unknown (or the keyboard
   * reconnected since), a fresh read (the factory map would not be what is on it). An Office-mode read hides the custom
   * bank, so the one the page knows is saved instead. Simulator backups are kept apart from the keyboard's. A failure
   * only warns: the write goes on.
   */
  const backupBeforeWrite = async (): Promise<void> => {
    setWriteBackup(null)
    let table = linkUnread ? null : baselineTable
    let source: WriteBackup['source'] = 'device'
    if (!table) {
      try {
        const res = await device.read()
        if (missingOf(res.seen)) throw new Error('读取不完整')
        if (knownBank && readsOffice(res)) table = knownBank
        else {
          table = res.table
          source = 'pre-read'
          dispatch({ type: 'setDevice', table })
          setDeviceStale(false)
        }
        setLinkUnread(false)
      } catch (e) {
        setBackupFailed(true)
        notify('warn', '写入前没能读取键盘，这次没有自动备份', joinSentences(errText(e), '写入照常进行。'), undefined, { topic: 'write' })
        return
      }
    }
    const profile = tableToProfile(table, { name: PRE_WRITE_BACKUP_NOTE })
    const target = sim ? 'simulator' : 'keyboard'
    try {
      // One deadline for opening the store and saving: a hung IndexedDB must not hold the write up.
      const save = async () => (await (store ?? getLocalStore())).addBackup(profile, PRE_WRITE_BACKUP_NOTE, target)
      const b = await withTimeout(save(), BACKUP_TIMEOUT_MS)
      setWriteBackup({ savedAt: b.savedAt, source, profile })
    } catch (e) {
      setBackupFailed(true)
      notify('warn', '写入前自动备份失败', joinSentences(errText(e), '写入照常进行。'), undefined, { topic: 'write' })
    }
  }

  /** 改回写入前的键位: the backup goes onto the page (undoable) and the confirmation shows what writing it changes. */
  const restoreWriteBackup = () => {
    if (!writeBackup) return
    dispatch({ type: 'replace', draft: withMeta(writeBackup.profile, presentRef.current), label: '改回写入前的键位' })
    setPreReadFailed(false)
    setRereadError(null)
    setWriteStage({ stage: 'confirm' })
  }

  /** A write that stopped before its first packet: the keyboard got nothing, so what the page knows of it still holds. */
  const untouched = (message: string) => setWriteStage({ stage: 'result', outcome: { kind: 'error', message, partial: false } })

  /** `keepBackup` (再写一次): the first attempt's backup is what the keyboard held before; it is not taken again. */
  const doWrite = async ({ keepBackup = false } = {}) => {
    const table = derived.table
    if (!table) return
    reverified.current = false
    if (!connected) return untouched('还没有连接键盘。')
    if (!keepBackup) setWritten(writeChanges)
    setWriteStage({ stage: 'writing' })
    dismissTopic('write')
    const unplugged = unplugs.current
    if (!keepBackup) {
      setBackupFailed(false)
      await backupBeforeWrite()
    }
    if (unplugs.current !== unplugged) return untouched('键盘已断开。')
    try {
      const res = await device.write(table)
      if (res.verified) finishWrite(table, { kind: 'verified' }, table)
      // The custom bank holds what was written; Office mode just hides it from reads.
      else if (res.likelyOfficeMode) finishWrite(table, { kind: 'office' }, table)
      else {
        const back = res.readBack!
        finishWrite(table, { kind: 'mismatch', rows: changeRows(table, back.table), incomplete: missingOf(back.seen) > 0 }, back.table)
      }
    } catch (e) {
      // A table the page itself rejects fails before the first packet. Otherwise part of it may be on the keyboard now:
      // what the page knows about the keyboard is no longer true.
      if (e instanceof DeviceError && e.kind === 'internal') return untouched(errText(e))
      setDeviceStale(true)
      setWriteStage({ stage: 'result', outcome: { kind: 'error', message: errText(e) } })
    }
  }

  const doReverify = async () => {
    const table = lastWrite?.table
    if (!table) return
    reverified.current = true
    setWriteStage({ stage: 'writing', reverify: true })
    try {
      const res = await device.verifyRead()
      const complete = missingOf(res.seen) === 0
      if (complete && diffTables(table, res.table).length === 0) finishWrite(table, { kind: 'verified' }, table)
      else if (res.matchesFactory && isCustom(table)) finishWrite(table, { kind: 'office' }, null)
      else finishWrite(table, { kind: 'mismatch', rows: changeRows(table, res.table), incomplete: !complete }, res.table)
    } catch (e) {
      setWriteStage({ stage: 'result', outcome: { kind: 'error', message: errText(e), reverify: true } })
    }
  }

  /**
   * 再写一次. After 重新校验 the page may have changed since that write: a different page goes through the
   * confirmation (and its own backup) instead of being written unseen.
   */
  const retryWrite = () => {
    const same = !!lastWrite && !!derived.table && diffTables(derived.table, lastWrite.table).length === 0
    if (reverified.current && !same) return void prepareWrite()
    void doWrite({ keepBackup: true })
  }

  // --- files -----------------------------------------------------------------------------------------------------
  const exportJson = (style: 'full' | 'diff-factory', profile: Draft = derived.normalized ?? ed.present, prefix = '84ec-s') => {
    try {
      const text = serializeProfile(profile, { style, schemaUrl: null })
      downloadText(stampedName(style === 'full' ? prefix : `${prefix}-diff`, 'json'), text, 'application/json')
      if (profile === (derived.normalized ?? ed.present)) setKeptLibrary(libraryKey(ed.present))
      if (!derived.normalized && profile === ed.present)
        notify('warn', '已导出，但页面上的键位还有错误', '导出的文件可以再导入继续编辑，但改正错误之前不能写入键盘。', undefined, { topic: 'file' })
    } catch (e) {
      notify('error', '导出失败', errText(e), undefined, { topic: 'file' })
    }
  }

  /** 另存为文件 in the write dialog: what is on the keyboard now. */
  const exportKeyboard = () => {
    if (baselineTable) exportJson('full', tableToProfile(baselineTable, { name: '键盘里的键位' }), '84ec-s-keyboard')
  }

  const startExportPro = () => {
    if (!derived.normalized) return void notify('error', '无法导出 .pro', '请先改正检查结果里的错误。', undefined, { topic: 'file' })
    try {
      const res = exportPro(derived.normalized)
      if (res.blockers.length) setProBlockers(res)
      else {
        downloadText(stampedName('84ec-s', 'pro'), res.text, 'application/xml')
        setKeptLibrary(libraryKey(ed.present))
      }
    } catch (e) {
      notify('error', '导出 .pro 失败', errText(e), undefined, { topic: 'file' })
    }
  }

  const importFile = async (file: File) => {
    const kind = fileKind(file.name)
    if (!kind) return void notify('error', `无法导入 ${file.name}`, '只支持 Plum Keymap 的 .json 文件和 KB84 的 .pro 文件。', undefined, { topic: 'file' })
    const text = await file.text()
    const res = kind === 'json' ? parseProfileJson(text) : parseProFile(text)
    if (!res.profile) {
      notify('error', `无法导入 ${file.name}`, <IssueList issues={res.issues.filter((i) => i.severity === 'error')} />, undefined, { topic: 'file' })
      return
    }
    const before = presentRef.current
    dispatch({ type: 'replace', draft: res.profile, label: `导入 ${file.name}` })
    setKeptLibrary(libraryKey(res.profile))
    const warnings = res.issues.filter((i) => i.severity === 'warning')
    const lib = libraryNote(before, res.profile, '文件')
    notify(
      warnings.length ? 'warn' : 'ok',
      `已导入 ${file.name}${warnings.length ? `（${warnings.length} 条提示）` : ''}`,
      warnings.length || lib ? <>{lib}{warnings.length > 0 && <IssueList issues={warnings} max={5} />}</> : undefined,
      undefined,
      { topic: 'file', change: before, undo: res.profile },
    )
  }

  const clearAll = (draft: Draft, keepFn: boolean) => {
    setClearOpen(false)
    const before = presentRef.current
    dispatch({ type: 'replace', draft, label: keepFn ? '全部清空' : '全部清空（含 Fn 和模式切换）' })
    if (keepFn) notify('ok', '已清空全部键位', '保留了 Fn 键和“办公/编程模式切换”。', undefined, { topic: 'edit', change: before, undo: draft })
    else
      notify(
        'warn',
        '已清空全部键位（包括 Fn 和模式切换）',
        '现在没有 Fn 键：写入后进不了 Fn 层，也切换不了办公/编程模式，只能用键盘复位（同时按住 Esc+Delete+左 Ctrl+→ 约 5 秒）恢复。',
        undefined,
        { topic: 'edit', change: before, undo: draft },
      )
  }

  const restoreAllFactory = () => {
    const before = presentRef.current
    const draft = withMeta(tableToProfile(FACTORY), before)
    dispatch({ type: 'replace', draft, label: '全部改回出厂键位' })
    notify('ok', '已把全部键位改回出厂键位', undefined, undefined, { topic: 'edit', change: before, undo: draft })
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void importFile(file)
  }

  // --- connection ------------------------------------------------------------------------------------------------
  const connectHid = () =>
    void device
      .connectHid()
      .then((ok) => ok && dismissTopic('connection'))
      .catch((e: Error) => {
        // The bar shows these itself, with 重试.
        if (e instanceof DeviceError && (e.kind === 'busy' || e.kind === 'denied')) return
        if (e.name !== 'NotFoundError') notify('error', '连接失败', errorBody(e), undefined, { topic: 'connection' })
      })
  const connectSim = () =>
    void device.connectSimulator().then(() => notify('info', '已连接模拟键盘', '不会改动真实键盘。连接栏里的 M 开关模拟按住 Fn+F12。', undefined, { topic: 'connection' }))

  // --- editing ---------------------------------------------------------------------------------------------------
  const { layer, selected } = ed
  const setKey = (l: LayerId, keyId: string, action: Action, label: string, coalesce?: string) =>
    dispatch({ type: 'setKey', layer: l, keyId, action, label, coalesce })

  const replaceDraft = useCallback((draft: Draft, label: string) => dispatch({ type: 'replace', draft, label }), [])
  const selectKey = (l: LayerId, keyId: string) => dispatch({ type: 'select', keyId, layer: l })
  const selectedLabel = selected ? `${LAYER_ZH[layer]} · ${keyById(selected)?.label ?? selected}` : undefined

  // An ok / info notice is about the page as it was: the next edit (or undo) closes it, and 撤销 shows only while
  // its own change is the one that would be undone (a later edit can push the same draft again, but not its result).
  const top = ed.past.at(-1)?.draft
  const alive = (n: AppNotice) => n.sticky || (n.tone !== 'ok' && n.tone !== 'info') || (n.change ? top === n.change : ed.present === n.born)
  if (notices.some((n) => !alive(n))) setNotices(notices.filter(alive))
  const shownNotices: Notice[] = notices.map((n) =>
    n.undoable && n.change && top === n.change && ed.present === n.result
      ? {
          ...n,
          actions: [
            ...(n.actions ?? []),
            {
              label: '撤销',
              onClick: () => {
                dismiss(n.id)
                dispatch({ type: 'undo' })
              },
            },
          ],
        }
      : n,
  )

  const testing = side === 'tester'
  const onHighlight = useCallback((ids: string[]) => setTesterKeys(new Set(ids)), [])
  const openSide = (s: Side) => {
    setSide(s)
    if (s !== 'tester') setTesterKeys(new Set())
  }
  /** × and Esc Esc in the key tester: back to 键位设置, focus on its tab. */
  const closeTester = useCallback(() => {
    focusSideTab.current = true
    setSide('inspector')
    setTesterKeys(new Set())
  }, [])
  useEffect(() => {
    if (!focusSideTab.current) return
    focusSideTab.current = false
    sideTabs.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
  }, [side])

  // Narrow windows stack the right column under the board: bring it into view when a key or a tool is picked, just
  // below the sticky toolbar (its tabs and the key's heading would sit under it otherwise).
  const shown = useRef({ selected, side })
  useEffect(() => {
    const prev = shown.current
    shown.current = { selected, side }
    if (!(side !== prev.side || (selected && selected !== prev.selected))) return
    if (typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 980px)').matches) return
    const el = document.querySelector('.inspector')
    if (!el) return
    const top = el.getBoundingClientRect().top + window.scrollY - (toolbar.current?.offsetHeight ?? 0) - SCROLL_GAP
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [selected, side])

  // The toolbar may wrap onto two lines at narrower widths; the sticky right column sits below whatever height it has.
  useLayoutEffect(() => {
    const el = toolbar.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const update = () => el.parentElement?.style.setProperty('--toolbar-h', `${el.offsetHeight}px`)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Unwritten edits, and a 动作库 that was never kept, live only in this page: ask before it goes.
  const unkept = unsaved > 0 || libraryKey(ed.present) !== keptLibrary
  useEffect(() => {
    if (!unkept) return
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [unkept])

  const modalOpen = writeStage !== null || helpOpen || confirm !== null || proBlockers !== null || profilesOpen || clearOpen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While the key tester is open every press is a test press, never an editor command.
      if (modalOpen || testing || e.defaultPrevented) return
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && (k === 'z' || k === 'y') && !isTypingTarget(e.target, true)) {
        e.preventDefault()
        dispatch({ type: k === 'y' || e.shiftKey ? 'redo' : 'undo' })
      } else if (!mod && !e.altKey && (e.key === '1' || e.key === '2') && !isTypingTarget(e.target)) {
        // Not from an open menu or popover: 1 / 2 would switch the layer behind it.
        if (e.target instanceof Element && e.target.closest('[role="menu"], [role="dialog"]')) return
        // The inspector remounts for the new layer: commit the switch now and keep focus in it, on its checked layer row.
        const held = e.target instanceof Element && !!e.target.closest('.insp')
        flushSync(() => dispatch({ type: 'setLayer', layer: e.key === '1' ? 'base' : 'fn' }))
        if (held && !document.activeElement?.closest('.insp'))
          document.querySelector<HTMLElement>('.insp .insp-layers [aria-checked="true"]')?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalOpen, testing])

  const faces = useMemo(() => buildFaces(ed.present, derived.status, layer), [derived.status, ed.present, layer])
  const pendingRows = useMemo(() => (ed.device && derived.table ? changeRows(ed.device, derived.table) : []), [ed.device, derived.table])

  const libCount = libraryCount(ed.present)
  const layerCount = (l: LayerId) => KEYS.filter((k) => derived.status[l][k.id].changed).length
  const undoLabel = ed.past.at(-1)?.label
  const redoLabel = ed.future[0]?.label
  const boardBusy = busy?.op === 'read' || busy?.op === 'write' || busy?.op === 'verify'
  /** A row of the 未写入 list or of the check results: its key, with its settings (not mid-read, like the board). */
  const pickKey = (l: LayerId, keyId: string) => {
    if (boardBusy) return
    selectKey(l, keyId)
    if (testing) openSide('inspector')
  }
  /** 打开按键测试 from the checklist: the panel replaces it, so focus goes to the tester's tab. */
  const openTester = () => {
    focusSideTab.current = true
    openSide('tester')
  }
  const verified = unsaved === 0 && !!lastWrite?.verified && ed.device === lastWrite.table
  // At most one vermilion button: 写入 once there is something to write, 读取 before anything is known.
  const writeHot = connected && unsaved > 0 && derived.errorCount === 0
  const readHot = connected && !ed.device && unsaved === 0
  const writeTitle = !connected
    ? '先连接键盘'
    : derived.errorCount
      ? `有 ${derived.errorCount} 个错误，改正后才能写入`
      : unsaved
        ? `${unsaved} 个键位的修改还没有写入键盘`
        : '没有未写入的修改（仍可重新写入全部键位）'
  const source = (() => {
    for (let i = ed.past.length - 1; i >= 0; i--) {
      const s = sourceOf(ed.past[i].label)
      if (s) return s
    }
    // A full history may have dropped the entry that said where the page came from.
    return ed.past.length < HISTORY_LIMIT ? '出厂键位' : null
  })()

  /** The store as 方案 uses it: saving the page as a 方案 keeps its 动作库, so leaving no longer needs asking. */
  const profilesStore = useMemo(
    () =>
      profilesOpen
        ? Promise.resolve(store ?? getLocalStore()).then(
            (s): LocalStore => ({
              ...s,
              saveProfile: async (name, profile, id) => {
                const saved = await s.saveProfile(name, profile, id)
                setKeptLibrary(libraryKey(presentRef.current))
                return saved
              },
            }),
          )
        : undefined,
    [profilesOpen, store],
  )

  const toggleLog = () =>
    setLogVisible((v) => {
      try {
        localStorage.setItem(LOG_KEY, v ? '0' : '1')
      } catch {
        // not persisted (private window, blocked storage): the toggle still works for this page
      }
      return !v
    })

  // 从这里开始: what is done, and the one step to do next. Ticking ② before a read only moves the list on.
  const steps = {
    connect: connected,
    mlight: connected && (mode === 'program' || (mode === 'unknown' && mlightTicked)),
    read: !!ed.device,
    edit: unsaved > 0 || lastWrite !== null,
    write: verified,
  }
  const current = (Object.keys(steps) as (keyof typeof steps)[]).find((k) => !steps[k])
  const stepState = (k: keyof typeof steps): StepState => (steps[k] ? 'is-done' : k === current ? 'is-current' : 'todo')
  // A step's button goes away once it is done: focus moves on to the next step's (or to that step), not to <body>.
  const stepList = useRef<HTMLOListElement>(null)
  const inSteps = useRef(false)
  useEffect(() => {
    const a = document.activeElement
    if (!inSteps.current || (a && a !== document.body)) return
    inSteps.current = false
    const step = stepList.current?.querySelector<HTMLElement>('.is-current')
    ;(step?.querySelector<HTMLElement>('button:not(:disabled)') ?? step)?.focus()
  }, [current])

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <header className="masthead">
        <div className="brand">
          <span className="brand-seal" aria-hidden="true">梅</span>
          <div>
            <h1>84EC-S 键位编程</h1>
            <p>NIZ Plum 静电容键盘 · 网页版改键工具</p>
          </div>
        </div>
        <ConnectionBar
          device={device.ui}
          onConnect={connectHid}
          onRetry={() =>
            void device
              .retry()
              .then((ok) => ok && dismissTopic('connection'))
              .catch((e: Error) => notify('error', '连接失败', errorBody(e), undefined, { topic: 'connection' }))
          }
          onAutoConnect={device.setAutoConnect}
          onDismissFailure={device.clearFailure}
          onSimulator={connectSim}
          onDisconnect={() => void device.disconnect()}
          onVersion={() => void device.readVersion().catch((e: Error) => notify('error', '查询固件版本失败', errorBody(e), undefined, { topic: 'connection' }))}
          onSimMode={device.setSimMode}
          modeHint={mode}
          onConfirmProgram={confirmProgram}
          onReread={requestRead}
          pendingVerify={pendingVerify}
          onReverify={() => void doReverify()}
        />
      </header>

      <nav className="toolbar" aria-label="主要操作" ref={toolbar}>
        <button type="button" className={`btn${readHot ? ' btn-primary' : ''}`} disabled={!connected || busy !== null} title={connected ? undefined : '先连接键盘'} onClick={requestRead}>
          <Icon name="read" />
          {busy?.op === 'read' ? `读取中 ${busy.done}/${busy.total || 168}` : '读取键盘'}
        </button>
        <button
          type="button"
          className={`btn${writeHot ? ' btn-primary' : ''}`}
          disabled={!connected || busy !== null || derived.errorCount > 0}
          title={writeTitle}
          onClick={() => void prepareWrite()}
        >
          <Icon name="write" />
          写入键盘
          {unsaved > 0 && <span className="btn-count" aria-hidden="true">{unsaved}</span>}
        </button>
        <SyncStatus
          connected={connected}
          read={ed.device !== null}
          unsaved={unsaved}
          errorCount={derived.errorCount}
          verified={verified}
          deviceStale={deviceStale}
          pendingRows={pendingRows}
          onShowErrors={() => setIssuesRequest((n) => n + 1)}
          onSelectKey={pickKey}
          onReread={requestRead}
        />
        <span className="toolbar-sep" />
        <button type="button" className="icon-btn" disabled={!undoLabel} onClick={() => dispatch({ type: 'undo' })} title={undoLabel ? `撤销：${undoLabel}（Ctrl+Z）` : '撤销'} aria-label="撤销">
          <Icon name="undo" />
        </button>
        <button type="button" className="icon-btn" disabled={!redoLabel} onClick={() => dispatch({ type: 'redo' })} title={redoLabel ? `重做：${redoLabel}（Ctrl+Shift+Z）` : '重做'} aria-label="重做">
          <Icon name="redo" />
        </button>
        <span className="toolbar-sep" />
        <PlanMenu
          onOpenProfiles={(t) => {
            setProfilesTab(t)
            setProfilesOpen(true)
          }}
          onExportJson={(full) => exportJson(full ? 'full' : 'diff-factory')}
          onExportPro={startExportPro}
          onImportFile={(f) => void importFile(f)}
        />
        <span className="spacer" />
        <button type="button" className="icon-btn" onClick={() => setHelpOpen(true)} aria-label="使用说明" title="使用说明">
          <Icon name="help" />
        </button>
      </nav>

      <Notices items={shownNotices} onDismiss={dismiss} fallbackFocus={() => toolbar.current?.querySelector<HTMLElement>('button:not(:disabled)')} />

      <main className="workspace">
        <section className={`board-area${boardBusy ? ' is-busy' : ''}`} aria-label="键盘" aria-busy={boardBusy || undefined}>
          <div className="board-head">
            <Segmented<LayerId>
              label="当前层"
              activation="auto"
              value={layer}
              onChange={(l) => dispatch({ type: 'setLayer', layer: l })}
              options={(['base', 'fn'] as const).map((l, i) => ({
                value: l,
                hint: `按 ${i + 1} 切换`,
                label: (
                  <>
                    {LAYER_ZH[l]}
                    {layerCount(l) > 0 && <span className="seg-count" title="与出厂不同的键数">{layerCount(l)}</span>}
                  </>
                ),
              }))}
            />
            {source && (
              <span className="board-source" title={`页面上的键位来自：${source}`}>
                页面上：{source}
              </span>
            )}
            <p className="board-hint">
              {testing ? (
                <>按键测试中：按下的键在图上亮起 · 编辑快捷键已暂停 · 连按两次 <kbd>Esc</kbd> 退出</>
              ) : layer === 'fn' ? (
                '按住 Fn 时各键的功能 · 灰色的键按住 Fn 时没有反应'
              ) : (
                '平时按下各键的功能 · 右下角小字 = 按住 Fn 时的功能'
              )}
            </p>
            <ul className="legend" aria-label="图例">
              <li><span className="sw sw-changed" />与出厂不同</li>
              {ed.device && <li><span className="sw sw-pending" />未写入</li>}
              {derived.errorCount > 0 && <li><span className="sw sw-invalid" />有错误</li>}
            </ul>
            <BulkMenu onFactoryAll={restoreAllFactory} onClearAll={() => setClearOpen(true)} disabled={boardBusy} />
          </div>
          <KeyboardView
            keys={KEYS}
            faces={faces}
            selected={selected}
            pressed={testing ? testerKeys : undefined}
            onSelect={testing || boardBusy ? undefined : (id) => dispatch({ type: 'select', keyId: id === selected ? null : id })}
            label={`84EC-S 键位 · ${LAYER_ZH[layer]}`}
            dimEmpty={layer === 'fn'}
            heldKeyId={layer === 'fn' && !testing ? 'fn' : undefined}
            caseLabel={layer === 'fn' ? 'Fn 层 · 按住 Fn 时生效' : '基础层'}
          />
          <IssuesPanel issues={derived.issues} onSelect={pickKey} openRequest={issuesRequest} />
        </section>

        <aside className="inspector" aria-label={SIDE_LABEL[side]}>
          <div className="side-tabs" ref={sideTabs}>
            <Segmented<Side>
              block
              size="sm"
              label="面板"
              value={side}
              onChange={openSide}
              options={[
                { value: 'inspector', label: '键位设置' },
                {
                  value: 'library',
                  hint: '起名保存的组合键、宏和连发（KB84 的预定义列表）',
                  label: (
                    <>
                      动作库
                      {libCount > 0 && <span className="lib-count" aria-label={`${libCount} 项`}>{libCount}</span>}
                    </>
                  ),
                },
                { value: 'tester', label: '按键测试', hint: '查看电脑实际收到的按键，检查写入的键位' },
              ]}
            />
          </div>
          {side === 'tester' ? (
            <KeyTesterPanel active={!modalOpen} onClose={closeTester} onHighlight={onHighlight} table={ed.device ?? undefined} />
          ) : side === 'library' ? (
            <div className="side-tool">
              <div className="side-tool-head">
                <span className="muted">{selectedLabel ? `当前键：${selectedLabel}` : '未选择键：先在键盘图上点一个键'}</span>
              </div>
              <LibraryPanel
                draft={ed.present}
                onChange={replaceDraft}
                selectedAction={selected ? (ed.present.layers[layer][selected] ?? { type: 'none' }) : null}
                selectedLabel={selectedLabel}
                onApply={(a, entry) => selected && setKey(layer, selected, a, `把“${entry.name}”用到 ${selectedLabel}`)}
                onSelectKey={selectKey}
              />
            </div>
          ) : selected ? (
            <Inspector
              key={`${layer}/${selected}`}
              layer={layer}
              keyId={selected}
              action={ed.present.layers[layer][selected] ?? { type: 'none' }}
              otherAction={ed.present.layers[layer === 'base' ? 'fn' : 'base'][selected] ?? { type: 'none' }}
              status={derived.status[layer][selected]}
              issues={derived.issuesByKey.get(keyRef(layer, selected)) ?? []}
              device={ed.device}
              onChange={(a, label, coalesce) => setKey(layer, selected, a, label, coalesce)}
              onMirrorFn={() => setKey(layer === 'base' ? 'fn' : 'base', selected, { type: 'key', code: 'Fn' }, `同步 Fn 到另一层`)}
              onLayer={(l) => dispatch({ type: 'setLayer', layer: l })}
              library={{ draft: ed.present, onChange: replaceDraft }}
            />
          ) : (
            <div className="insp-empty">
              <h2>{steps.connect && steps.mlight && steps.read ? '选择一个键' : '从这里开始'}</h2>
              <ol
                className="steps-intro"
                ref={stepList}
                onFocus={() => {
                  inSteps.current = true
                }}
                onBlur={() => {
                  inSteps.current = false
                }}
              >
                <Step state={stepState('connect')} title="连接键盘" sub={connected && `已连接${sim ? '模拟键盘' : ''} ${device.ui.name}`}>
                  {current === 'connect' && (
                    <>
                      <button type="button" className="btn btn-sm" onClick={connectHid} disabled={device.ui.support !== 'ok' || busy !== null}>
                        连接键盘
                      </button>
                      <button type="button" className="link-btn" onClick={connectSim} disabled={busy !== null}>
                        使用模拟键盘
                      </button>
                    </>
                  )}
                </Step>
                <Step
                  state={stepState('mlight')}
                  title="确认 F12 上的 M 灯亮着"
                  sub={sim ? '模拟键盘：点连接栏里的 M 开关切换' : '不亮就按住 Fn+F12 约 2 秒（编程模式）'}
                >
                  {/* Before a read it is a tick; after a factory read it answers the doubt. Office mode was read, not guessed. */}
                  {current === 'mlight' && !sim && mode !== 'office' && !pendingVerify && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={mode === 'maybe-office' ? confirmProgram : () => setMlightTicked(true)}
                      aria-label="M 灯亮着"
                    >
                      亮着
                    </button>
                  )}
                </Step>
                <Step state={stepState('read')} title="读取键盘" sub={steps.read && '已读取'}>
                  {current === 'read' && (
                    <button type="button" className="btn btn-sm" onClick={requestRead} disabled={!connected || busy !== null}>
                      <Icon name="read" size={14} />读取键盘
                    </button>
                  )}
                </Step>
                <Step state={stepState('edit')} title={`在键盘图上点一个键，改它在${LAYER_ZH[layer]}上的功能`} />
                <Step
                  state={stepState('write')}
                  title="写入键盘"
                  sub={
                    steps.write ? (
                      <>
                        已写入。直接按键试试，或
                        <button type="button" className="link-btn" onClick={openTester}>
                          打开按键测试
                        </button>
                        。
                      </>
                    ) : (
                      '写入前自动备份，写完自动校验'
                    )
                  }
                />
              </ol>
              <p className="muted steps-foot">改错了可以按 Ctrl+Z 撤销。</p>
            </div>
          )}
        </aside>
      </main>

      <PacketLogDrawer log={log} visible={logVisible} />

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div>松开以导入 .json 或 .pro 文件</div>
        </div>
      )}

      {writeStage && (
        <WriteDialog
          stage={writeStage}
          changes={writeChanges}
          baseline={baselineTable ? 'device' : 'factory'}
          warnings={derived.issues.filter((i) => i.severity === 'warning')}
          cautions={cautions}
          busy={busy}
          onBackup={exportKeyboard}
          onConfirm={() => void doWrite()}
          onReverify={() => void doReverify()}
          onClose={() => setWriteStage(null)}
          backup={writeBackup}
          onRestoreBackup={restoreWriteBackup}
          modeWarning={modeWarning}
          onReread={() => void prepareWrite(true)}
          rereadError={rereadError}
          onRetry={retryWrite}
          onOpenTester={() => {
            setWriteStage(null)
            openSide('tester')
          }}
          written={written}
          writtenIsFactory={writtenIsFactory}
          backupFailed={backupFailed}
          preReadFailed={preReadFailed}
          onCancelPrepare={cancelPrepare}
        />
      )}
      {profilesOpen && (
        <ProfilesDialog
          open
          initialTab={profilesTab}
          onClose={() => setProfilesOpen(false)}
          current={ed.present}
          store={profilesStore}
          onLoad={(p, r) => {
            const before = presentRef.current
            dispatch({ type: 'replace', draft: p, label: `载入方案“${r.name}”` })
            setKeptLibrary(libraryKey(p))
            notify('ok', `已载入方案“${r.name}”`, libraryNote(before, p, '方案') ?? undefined, undefined, { topic: 'file', change: before, undo: p })
          }}
          onRestoreBackup={(p, b) => {
            const before = presentRef.current
            const draft = withMeta(p, before)
            dispatch({ type: 'replace', draft, label: `载入自动备份 ${shortWhen(b.savedAt)}` })
            notify('ok', '已把自动备份载入到页面', `备份时间 ${new Date(b.savedAt).toLocaleString()}。`, undefined, { topic: 'file', change: before, undo: draft })
          }}
        />
      )}
      {clearOpen && <ClearAllDialog draft={ed.present} onClose={() => setClearOpen(false)} onConfirm={(r, keepFn) => clearAll(r.draft, keepFn)} />}
      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} logVisible={logVisible} onToggleLog={toggleLog} />}
      {confirm && (
        <Dialog
          title={confirm.title}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirm(null)}>取消</button>
              <button type="button" className="btn btn-ink" onClick={() => { setConfirm(null); confirm.onConfirm() }}>{confirm.confirmLabel}</button>
            </>
          }
        >
          <p className="lead">{confirm.body}</p>
        </Dialog>
      )}
      {proBlockers && (
        <Dialog
          title="KB84 无法表示部分键位"
          onClose={() => setProBlockers(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setProBlockers(null)}>取消</button>
              <button
                type="button"
                className="btn btn-ink"
                onClick={() => {
                  downloadText(stampedName('84ec-s', 'pro'), proBlockers.text, 'application/xml')
                  setProBlockers(null)
                }}
              >
                将这些键留空并导出
              </button>
            </>
          }
        >
          <p className="lead">下面这些内容无法保存到 KB84 的 .pro 文件里。可以把它们留空后导出，或者取消后改用 JSON 导出（JSON 能完整保存）。</p>
          <ul className="notice-list">
            {proBlockers.blockers.map((b) => (
              <li key={b.path}><b>{b.where}</b>：{b.reason}</li>
            ))}
          </ul>
        </Dialog>
      )}
    </div>
  )
}
