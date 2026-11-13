/**
 * Local persistence for named profiles (我的方案) and automatic backups (自动备份) of the keyboard contents.
 *
 * Storage: IndexedDB when it opens, else localStorage, else memory (lost on reload). Every access to browser storage
 * is wrapped in try/catch; failures surface as StoreError with a Chinese message. Each collection is one versioned
 * JSON document `{ format: "plum-local", kind, version, items }` under a fixed key; items are schema-checked on every
 * read and invalid ones are dropped (and reported in `problems`). Profiles are stored as serializeProfile() JSON
 * text, so a stored profile is exactly the documented Plum Keymap interchange format (docs/FORMAT.md).
 */
import { parseProfileJson } from '../../format/normalize'
import { serializeProfile } from '../../format/serialize'
import type { FormatIssue, NormalizedProfile } from '../../format/types'

export const STORE_VERSION = 1
export const BACKUP_LIMIT = 20
/** Backups of simulator writes are kept apart, so trying things out never pushes out a real keyboard's backups. */
export const SIM_BACKUP_LIMIT = 5
export const PROFILES_KEY = 'plum-kb84.profiles'
export const BACKUPS_KEY = 'plum-kb84.backups'
export const IDB_NAME = 'plum-kb84'
export const IDB_STORE = 'kv'

export type StorageKind = 'indexeddb' | 'localstorage' | 'memory'

export interface SavedProfile {
  id: string
  name: string
  /** ms since epoch */
  savedAt: number
  /** serializeProfile() text of the profile. */
  profileJson: string
}

/** Which keyboard a backup was taken from. Each kind has its own retention limit. */
export type BackupTarget = 'keyboard' | 'simulator'

export interface Backup {
  id: string
  savedAt: number
  /** e.g. "写入前备份" */
  note: string
  /** Records saved before this field existed are 'keyboard'. */
  target: BackupTarget
  /** serializeProfile() text of the keyboard contents. */
  profileJson: string
}

export interface Loaded<T> {
  record: T
  /** Null when the stored JSON no longer validates (see issues). */
  profile: NormalizedProfile | null
  issues: FormatIssue[]
}

export type StoreErrorCode = 'quota' | 'unavailable' | 'not-found' | 'invalid' | 'newer'

export class StoreError extends Error {
  readonly code: StoreErrorCode
  constructor(code: StoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StoreError'
    this.code = code
  }
}

/** A string key/value backend. Implementations reject with StoreError. */
export interface KvBackend {
  readonly kind: StorageKind
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export interface LocalStore {
  readonly kind: StorageKind
  /** Non-fatal problems found while opening or reading (Chinese), e.g. dropped invalid records. */
  readonly problems: readonly string[]
  /** Newest first. */
  listProfiles(): Promise<SavedProfile[]>
  /** Saves a new profile, or overwrites the one with `id`. Throws StoreError('invalid') if it does not validate. */
  saveProfile(name: string, profile: NormalizedProfile, id?: string): Promise<SavedProfile>
  renameProfile(id: string, name: string): Promise<SavedProfile>
  deleteProfile(id: string): Promise<void>
  loadProfile(id: string): Promise<Loaded<SavedProfile>>
  /** Newest first. */
  listBackups(): Promise<Backup[]>
  /**
   * Adds a backup and keeps only the newest `backupLimit` of its target (SIM_BACKUP_LIMIT for the simulator). If the
   * newest backup of that target already holds identical content, it is returned instead of adding a duplicate. On a
   * quota error the oldest backups are dropped and it retries once.
   */
  addBackup(profile: NormalizedProfile, note?: string, target?: BackupTarget): Promise<Backup>
  restoreBackup(id: string): Promise<Loaded<Backup>>
  deleteBackup(id: string): Promise<void>
}

export interface LocalStoreOptions {
  /** Use this backend and skip detection. */
  backend?: KvBackend
  /** IndexedDB factory; default globalThis.indexedDB, null disables it. */
  indexedDB?: IDBFactory | null
  /** localStorage; default globalThis.localStorage, null disables it. */
  localStorage?: Storage | null
  now?: () => number
  newId?: () => string
  backupLimit?: number
  /** Give up on IndexedDB if it has not opened after this long (blocked / hung opens). Default 3000. */
  openTimeoutMs?: number
}

// --- errors ----------------------------------------------------------------------------------------------------

function isQuota(e: unknown): boolean {
  const err = e as { name?: string; code?: number } | null
  return !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014)
}

function toStoreError(e: unknown, what: string): StoreError {
  if (e instanceof StoreError) return e
  if (isQuota(e)) return new StoreError('quota', '浏览器的本地存储空间已满。请删除一些旧方案或备份，或者改用导出文件保存。', { cause: e })
  const detail = e instanceof Error && e.message ? `（${e.message}）` : ''
  return new StoreError('unavailable', `浏览器本地存储${what}失败${detail}`, { cause: e })
}

// --- backends --------------------------------------------------------------------------------------------------

export function memoryBackend(seed?: Record<string, string>): KvBackend {
  const map = new Map(Object.entries(seed ?? {}))
  return {
    kind: 'memory',
    get: async (k) => map.get(k),
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  }
}

export function localStorageBackend(storage: Storage): KvBackend {
  const wrap = <T>(what: string, fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn())
    } catch (e) {
      return Promise.reject(toStoreError(e, what))
    }
  }
  return {
    kind: 'localstorage',
    get: (k) => wrap('读取', () => storage.getItem(k) ?? undefined),
    set: (k, v) => wrap('保存', () => storage.setItem(k, v)),
    delete: (k) => wrap('删除', () => storage.removeItem(k)),
  }
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Opens (creating if needed) the database. Rejects on error, block or timeout. */
export function openIndexedDb(factory: IDBFactory, timeoutMs = 3000): Promise<KvBackend> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new StoreError('unavailable', 'IndexedDB 打开超时'))), timeoutMs)
    try {
      const req = factory.open(IDB_NAME, 1)
      req.onupgradeneeded = () => {
        try {
          if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE)
        } catch (e) {
          done(() => reject(e))
        }
      }
      req.onsuccess = () => {
        const db = req.result
        if (settled) return void db.close()
        done(() => resolve(db))
      }
      req.onerror = () => done(() => reject(req.error))
      req.onblocked = () => done(() => reject(new StoreError('unavailable', 'IndexedDB 被其他页面占用')))
    } catch (e) {
      done(() => reject(e))
    }
  }).then((db) => {
    const run = <T>(mode: IDBTransactionMode, what: string, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        try {
          const tx = db.transaction(IDB_STORE, mode)
          let result: T
          idbRequest(fn(tx.objectStore(IDB_STORE))).then((r) => (result = r), () => {})
          tx.oncomplete = () => resolve(result)
          const fail = () => reject(toStoreError(tx.error, what))
          tx.onabort = fail
          tx.onerror = fail
        } catch (e) {
          reject(toStoreError(e, what))
        }
      })
    return {
      kind: 'indexeddb',
      get: (k) => run('readonly', '读取', (s) => s.get(k) as IDBRequest<unknown>).then((v) => (typeof v === 'string' ? v : undefined)),
      set: (k, v) => run('readwrite', '保存', (s) => s.put(v, k)).then(() => undefined),
      delete: (k) => run('readwrite', '删除', (s) => s.delete(k)),
    } satisfies KvBackend
  })
}

/** Global storage objects, read defensively (accessing them can throw in sandboxed frames). */
function globalOr<T>(get: () => T | undefined): T | null {
  try {
    return get() ?? null
  } catch {
    return null
  }
}

/** localStorage only counts as available when a write/remove round trip works. */
function probeLocalStorage(storage: Storage | null): Storage | null {
  if (!storage) return null
  try {
    const k = '__plum_probe__'
    storage.setItem(k, '1')
    storage.removeItem(k)
    return storage
  } catch {
    return null
  }
}

/** Picks the best working backend: IndexedDB, then localStorage, then memory. Never throws. */
export async function detectBackend(opts: LocalStoreOptions = {}): Promise<{ backend: KvBackend; problems: string[] }> {
  const problems: string[] = []
  const idb = opts.indexedDB !== undefined ? opts.indexedDB : globalOr(() => globalThis.indexedDB)
  if (idb) {
    try {
      return { backend: await openIndexedDb(idb, opts.openTimeoutMs), problems }
    } catch {
      problems.push('IndexedDB 不可用，改用 localStorage')
    }
  }
  const ls = probeLocalStorage(opts.localStorage !== undefined ? opts.localStorage : globalOr(() => globalThis.localStorage))
  if (ls) return { backend: localStorageBackend(ls), problems }
  problems.push('浏览器不允许本地存储：方案和备份只保存在当前页面，刷新后会丢失')
  return { backend: memoryBackend(), problems }
}

// --- documents ---------------------------------------------------------------------------------------------------

type Kind = 'profiles' | 'backups'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function checkProfile(v: unknown): SavedProfile | null {
  if (!isObj(v) || !isStr(v.id) || !v.id || !isStr(v.name) || !isTime(v.savedAt) || !isStr(v.profileJson)) return null
  return { id: v.id, name: v.name, savedAt: v.savedAt, profileJson: v.profileJson }
}

function checkBackup(v: unknown): Backup | null {
  if (!isObj(v) || !isStr(v.id) || !v.id || !isTime(v.savedAt) || !isStr(v.profileJson)) return null
  const target: BackupTarget = v.target === 'simulator' ? 'simulator' : 'keyboard'
  return { id: v.id, savedAt: v.savedAt, note: isStr(v.note) ? v.note : '', target, profileJson: v.profileJson }
}

const KIND_ZH: Record<Kind, string> = { profiles: '方案', backups: '备份' }

interface Doc<T> {
  items: T[]
  /** Set when the stored document is from a newer version: never overwrite it. */
  readOnly: boolean
  /** The stored text could not be used at all (kept aside before the first overwrite). */
  corruptRaw?: string
}

function parseDoc<T>(kind: Kind, raw: string | undefined, check: (v: unknown) => T | null, problems: string[]): Doc<T> {
  if (raw === undefined) return { items: [], readOnly: false }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    problems.push(`本地保存的${KIND_ZH[kind]}数据已损坏，无法读取（原数据已另存）`)
    return { items: [], readOnly: false, corruptRaw: raw }
  }
  if (!isObj(data) || data.format !== 'plum-local' || data.kind !== kind || !Array.isArray(data.items) || typeof data.version !== 'number') {
    problems.push(`本地保存的${KIND_ZH[kind]}数据格式不正确，无法读取（原数据已另存）`)
    return { items: [], readOnly: false, corruptRaw: raw }
  }
  if (data.version > STORE_VERSION) {
    problems.push(`本地${KIND_ZH[kind]}由更新版本的程序保存，只能查看，不能修改`)
  }
  const items: T[] = []
  let dropped = 0
  for (const it of data.items) {
    const ok = check(it)
    if (ok) items.push(ok)
    else dropped++
  }
  if (dropped) problems.push(`有 ${dropped} 条本地${KIND_ZH[kind]}记录不完整，已忽略`)
  return { items, readOnly: data.version > STORE_VERSION }
}

const docText = (kind: Kind, items: unknown[]) => JSON.stringify({ format: 'plum-local', kind, version: STORE_VERSION, items })

const newestFirst = <T extends { savedAt: number }>(list: T[]) => [...list].sort((a, b) => b.savedAt - a.savedAt)

function defaultId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** The JSON text stored for a profile; throws StoreError('invalid') if it would not load back. */
function storedJson(profile: NormalizedProfile): string {
  let text: string
  try {
    text = serializeProfile(profile, { schemaUrl: null })
  } catch (e) {
    throw new StoreError('invalid', `无法保存：${(e as Error).message}`, { cause: e })
  }
  const back = parseProfileJson(text)
  if (!back.profile) {
    const n = back.issues.filter((i) => i.severity === 'error').length
    throw new StoreError('invalid', `当前配置有 ${n} 个错误，修正后才能保存`)
  }
  return text
}

function cleanName(name: string): string {
  const n = name.trim()
  if (!n) throw new StoreError('invalid', '方案名称不能为空')
  if (n.length > 60) throw new StoreError('invalid', '方案名称最多 60 个字符')
  return n
}

export function createLocalStore(backend: KvBackend, opts: Omit<LocalStoreOptions, 'backend'> & { problems?: string[] } = {}): LocalStore {
  const problems: string[] = [...(opts.problems ?? [])]
  const now = opts.now ?? Date.now
  const newId = opts.newId ?? defaultId
  const limit = Math.max(1, opts.backupLimit ?? BACKUP_LIMIT)
  const reported = new Set<string>(problems)
  const note = (list: string[]) => {
    for (const p of list) {
      if (reported.has(p)) continue
      reported.add(p)
      problems.push(p)
    }
  }

  // Operations run one at a time so read-modify-write cycles never interleave.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }

  const keyOf = (kind: Kind) => (kind === 'profiles' ? PROFILES_KEY : BACKUPS_KEY)

  async function read<T>(kind: Kind, check: (v: unknown) => T | null): Promise<Doc<T>> {
    const found: string[] = []
    const doc = parseDoc(kind, await backend.get(keyOf(kind)), check, found)
    note(found)
    return doc
  }

  async function write<T>(kind: Kind, doc: Doc<T>, items: T[]): Promise<void> {
    if (doc.readOnly) throw new StoreError('newer', `本地${KIND_ZH[kind]}由更新版本的程序保存，不能修改`)
    if (doc.corruptRaw !== undefined) {
      // Keep the unreadable text once, so a bad document is never silently destroyed.
      const aside = `${keyOf(kind)}.corrupt`
      if ((await backend.get(aside)) === undefined) await backend.set(aside, doc.corruptRaw)
      doc.corruptRaw = undefined
    }
    await backend.set(keyOf(kind), docText(kind, items))
  }

  const profiles = () => read('profiles', checkProfile)
  const backups = () => read('backups', checkBackup)

  function loaded<T extends { profileJson: string }>(record: T): Loaded<T> {
    const { profile, issues } = parseProfileJson(record.profileJson)
    return { record, profile, issues }
  }

  return {
    get kind() {
      return backend.kind
    },
    problems,

    listProfiles: () => serial(async () => newestFirst((await profiles()).items)),

    saveProfile: (name, profile, id) =>
      serial(async () => {
        const rec: SavedProfile = { id: id ?? newId(), name: cleanName(name), savedAt: now(), profileJson: storedJson(profile) }
        const doc = await profiles()
        const items = doc.items.filter((p) => p.id !== rec.id)
        await write('profiles', doc, [...items, rec])
        return rec
      }),

    renameProfile: (id, name) =>
      serial(async () => {
        const doc = await profiles()
        const old = doc.items.find((p) => p.id === id)
        if (!old) throw new StoreError('not-found', '找不到这个方案，可能已在其他页面删除')
        const rec = { ...old, name: cleanName(name) }
        await write('profiles', doc, doc.items.map((p) => (p.id === id ? rec : p)))
        return rec
      }),

    deleteProfile: (id) =>
      serial(async () => {
        const doc = await profiles()
        if (doc.items.some((p) => p.id === id)) await write('profiles', doc, doc.items.filter((p) => p.id !== id))
      }),

    loadProfile: (id) =>
      serial(async () => {
        const rec = (await profiles()).items.find((p) => p.id === id)
        if (!rec) throw new StoreError('not-found', '找不到这个方案，可能已在其他页面删除')
        return loaded(rec)
      }),

    listBackups: () => serial(async () => newestFirst((await backups()).items)),

    addBackup: (profile, noteText = '写入前备份', target = 'keyboard') =>
      serial(async () => {
        // A backup must be kept even if it would not validate (restoreBackup then reports the issues).
        let json: string
        try {
          json = serializeProfile(profile, { schemaUrl: null })
        } catch (e) {
          throw new StoreError('invalid', `无法备份：${(e as Error).message}`, { cause: e })
        }
        const doc = await backups()
        const sorted = newestFirst(doc.items)
        const same = sorted.filter((b) => b.target === target)
        if (same[0] && same[0].profileJson === json) return same[0]
        const rec: Backup = { id: newId(), savedAt: now(), note: noteText, target, profileJson: json }
        const own = [rec, ...same].slice(0, target === 'simulator' ? Math.min(limit, SIM_BACKUP_LIMIT) : limit)
        let keep = newestFirst([...own, ...sorted.filter((b) => b.target !== target)])
        try {
          await write('backups', doc, keep)
        } catch (e) {
          if (!(e instanceof StoreError && e.code === 'quota') || keep.length <= 1) throw e
          // Make room from the simulator's backups first; a simulator backup never costs a keyboard backup.
          const sims = keep.filter((b) => b.target === 'simulator' && b !== rec)
          if (sims.length) keep = keep.filter((b) => !sims.includes(b))
          else if (target === 'simulator') throw e
          else keep = keep.slice(0, Math.max(1, Math.floor(keep.length / 2)))
          await write('backups', doc, keep)
          note([
            sims.length
              ? `存储空间不足，已删除模拟键盘的备份`
              : `存储空间不足，已删除较早的备份，只保留最近 ${keep.length} 份`,
          ])
        }
        return rec
      }),

    restoreBackup: (id) =>
      serial(async () => {
        const rec = (await backups()).items.find((b) => b.id === id)
        if (!rec) throw new StoreError('not-found', '找不到这份备份，可能已被删除')
        return loaded(rec)
      }),

    deleteBackup: (id) =>
      serial(async () => {
        const doc = await backups()
        if (doc.items.some((b) => b.id === id)) await write('backups', doc, doc.items.filter((b) => b.id !== id))
      }),
  }
}

/** Detects the best backend and creates a store on it. Never rejects. */
export async function openLocalStore(opts: LocalStoreOptions = {}): Promise<LocalStore> {
  if (opts.backend) return createLocalStore(opts.backend, opts)
  const { backend, problems } = await detectBackend(opts)
  return createLocalStore(backend, { ...opts, problems })
}

let shared: Promise<LocalStore> | null = null

/** The app-wide store (opened once, on first use). */
export function getLocalStore(): Promise<LocalStore> {
  shared ??= openLocalStore()
  return shared
}

/** Test hook: forget the app-wide store. */
export function resetLocalStoreForTests(): void {
  shared = null
}
