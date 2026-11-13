import { describe, expect, it } from 'vitest'
import { FACTORY } from '../../device/layout'
import { tableToProfile } from '../../format/compile'
import { serializeProfile } from '../../format/serialize'
import type { NormalizedProfile } from '../../format/types'
import { factoryDraft } from './editor'
import { addToLibrary } from './library'
import {
  BACKUP_LIMIT,
  SIM_BACKUP_LIMIT,
  BACKUPS_KEY,
  createLocalStore,
  detectBackend,
  memoryBackend,
  openLocalStore,
  PROFILES_KEY,
  StoreError,
  type KvBackend,
} from './localStore'

/** Map-backed Storage; `quota` limits the total stored characters; `broken` makes every call throw. */
class FakeStorage implements Storage {
  map = new Map<string, string>()
  quota: number
  broken: boolean
  constructor(quota = Infinity, broken = false) {
    this.quota = quota
    this.broken = broken
  }
  get length() {
    return this.map.size
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null
  }
  getItem(k: string) {
    if (this.broken) throw new DOMException('denied', 'SecurityError')
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    if (this.broken) throw new DOMException('denied', 'SecurityError')
    const used = [...this.map].reduce((n, [key, val]) => n + (key === k ? 0 : val.length), 0)
    if (used + v.length > this.quota) throw new DOMException('full', 'QuotaExceededError')
    this.map.set(k, v)
  }
  removeItem(k: string) {
    if (this.broken) throw new DOMException('denied', 'SecurityError')
    this.map.delete(k)
  }
  clear() {
    this.map.clear()
  }
}

type Handler = (() => void) | null
interface FakeReq {
  result?: unknown
  error?: unknown
  onsuccess: Handler
  onerror: Handler
  onupgradeneeded?: Handler
  onblocked?: Handler
}

/** A tiny IndexedDB stand-in: one database, one object store, async callbacks like the real thing. */
function fakeIndexedDB(opts: { putError?: () => unknown; hang?: boolean; openThrows?: boolean } = {}) {
  const data = new Map<string, unknown>()
  let created = false
  const later = (fn: () => void) => setTimeout(fn, 0)
  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore: () => {
      created = true
    },
    close: () => {},
    transaction: () => {
      const tx: { error: unknown; oncomplete: Handler; onabort: Handler; onerror: Handler; objectStore: () => unknown } = {
        error: null,
        oncomplete: null,
        onabort: null,
        onerror: null,
        objectStore: () => store,
      }
      const req = (fn: () => unknown): FakeReq => {
        const r: FakeReq = { onsuccess: null, onerror: null }
        later(() => {
          try {
            r.result = fn()
            r.onsuccess?.()
            later(() => tx.oncomplete?.())
          } catch (e) {
            r.error = e
            tx.error = e
            r.onerror?.()
            tx.onabort?.()
          }
        })
        return r
      }
      const store = {
        get: (k: string) => req(() => data.get(k)),
        put: (v: unknown, k: string) =>
          req(() => {
            const err = opts.putError?.()
            if (err) throw err
            data.set(k, v)
          }),
        delete: (k: string) => req(() => void data.delete(k)),
      }
      return tx
    },
  }
  const factory = {
    open: () => {
      if (opts.openThrows) throw new DOMException('no', 'InvalidStateError')
      const r: FakeReq = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null }
      if (!opts.hang)
        later(() => {
          r.result = db
          if (!created) r.onupgradeneeded?.()
          r.onsuccess?.()
        })
      return r
    },
  }
  return { factory: factory as unknown as IDBFactory, data }
}

const factory = (): NormalizedProfile => factoryDraft()
const withCaps = (code: string): NormalizedProfile => {
  const p = factoryDraft()
  p.layers.base.caps = { type: 'key', code }
  return p
}

function clockAndIds() {
  let t = 1_700_000_000_000
  let n = 0
  return { now: () => (t += 1000), newId: () => `id${++n}` }
}

describe('backend detection and fallbacks', () => {
  it('uses IndexedDB when it opens, and data persists across stores', async () => {
    const idb = fakeIndexedDB()
    const ls = new FakeStorage()
    const a = await openLocalStore({ indexedDB: idb.factory, localStorage: ls })
    expect(a.kind).toBe('indexeddb')
    await a.saveProfile('办公', factory())
    expect(typeof idb.data.get(PROFILES_KEY)).toBe('string')
    expect(ls.map.size).toBe(0)
    const b = await openLocalStore({ indexedDB: idb.factory, localStorage: ls })
    expect((await b.listProfiles()).map((p) => p.name)).toEqual(['办公'])
    await b.deleteProfile((await b.listProfiles())[0].id)
    expect(await a.listProfiles()).toEqual([])
  })

  it('falls back to localStorage when IndexedDB is absent, throws, or hangs', async () => {
    for (const indexedDB of [null, fakeIndexedDB({ openThrows: true }).factory, fakeIndexedDB({ hang: true }).factory]) {
      const ls = new FakeStorage()
      const s = await openLocalStore({ indexedDB, localStorage: ls, openTimeoutMs: 20 })
      expect(s.kind).toBe('localstorage')
      await s.saveProfile('游戏', factory())
      expect(JSON.parse(ls.map.get(PROFILES_KEY)!)).toMatchObject({ format: 'plum-local', kind: 'profiles', version: 1 })
    }
  })

  it('falls back to memory when both storages fail, and still works', async () => {
    for (const localStorage of [null, new FakeStorage(Infinity, true), new FakeStorage(0)]) {
      const { backend, problems } = await detectBackend({ indexedDB: null, localStorage })
      expect(backend.kind).toBe('memory')
      expect(problems.join()).toMatch(/刷新后会丢失/)
      const s = createLocalStore(backend, { problems })
      await s.saveProfile('临时', factory())
      expect(await s.listProfiles()).toHaveLength(1)
      expect(s.problems.length).toBeGreaterThan(0)
    }
  })

})

describe('profiles', () => {
  it('saves, lists newest first, renames, loads and deletes', async () => {
    const s = createLocalStore(memoryBackend(), clockAndIds())
    const lib = addToLibrary(withCaps('Escape'), { type: 'combo', keys: ['ControlLeft', 'KeyC'] }).draft
    const a = await s.saveProfile('  办公  ', lib)
    const b = await s.saveProfile('游戏', factory())
    expect(a).toMatchObject({ id: 'id1', name: '办公' })
    expect(a.profileJson).toBe(serializeProfile(lib, { schemaUrl: null }))
    expect((await s.listProfiles()).map((p) => p.name)).toEqual(['游戏', '办公'])

    expect(await s.renameProfile(a.id, '工作')).toMatchObject({ id: a.id, name: '工作' })
    const loaded = await s.loadProfile(a.id)
    expect(loaded.record.name).toBe('工作')
    expect(loaded.profile!.layers.base.caps).toEqual({ type: 'key', code: 'Escape' })
    expect(loaded.profile!.library).toEqual(lib.library)

    // overwrite by id keeps a single record
    await s.saveProfile('游戏', withCaps('KeyA'), b.id)
    expect(await s.listProfiles()).toHaveLength(2)
    expect((await s.loadProfile(b.id)).profile!.layers.base.caps).toEqual({ type: 'key', code: 'KeyA' })

    await s.deleteProfile(a.id)
    await s.deleteProfile('missing')
    expect((await s.listProfiles()).map((p) => p.id)).toEqual([b.id])
    await expect(s.loadProfile(a.id)).rejects.toMatchObject({ code: 'not-found' })
    await expect(s.renameProfile(a.id, 'x')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses empty names and profiles that would not load back', async () => {
    const s = createLocalStore(memoryBackend())
    await expect(s.saveProfile('  ', factory())).rejects.toBeInstanceOf(StoreError)
    const bad = factoryDraft()
    bad.layers.base.caps = { type: 'combo', keys: ['KeyA'] }
    await expect(s.saveProfile('坏的', bad)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/错误/) })
    expect(await s.listProfiles()).toEqual([])
  })

  it('reports a full storage as a quota error and keeps the old data', async () => {
    const ls = new FakeStorage()
    const s = createLocalStore((await detectBackend({ indexedDB: null, localStorage: ls })).backend)
    await s.saveProfile('一', factory())
    ls.quota = ls.map.get(PROFILES_KEY)!.length + 100
    const err = await s.saveProfile('二', factory()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StoreError)
    expect(err).toMatchObject({ code: 'quota', message: expect.stringMatching(/空间已满/) })
    expect((await s.listProfiles()).map((p) => p.name)).toEqual(['一'])
  })

  it('surfaces IndexedDB write failures as StoreError', async () => {
    let fail: unknown = null
    const idb = fakeIndexedDB({ putError: () => fail })
    const s = await openLocalStore({ indexedDB: idb.factory })
    await s.saveProfile('ok', factory())
    fail = new DOMException('full', 'QuotaExceededError')
    await expect(s.saveProfile('x', factory())).rejects.toMatchObject({ code: 'quota' })
    fail = new DOMException('gone', 'UnknownError')
    await expect(s.saveProfile('x', factory())).rejects.toMatchObject({ code: 'unavailable' })
    fail = null
    expect((await s.listProfiles()).map((p) => p.name)).toEqual(['ok'])
  })
})

describe('schema checks and parse errors', () => {
  const doc = (kind: string, items: unknown[], version = 1) => JSON.stringify({ format: 'plum-local', kind, version, items })

  it('drops invalid records and reports them once', async () => {
    const good = { id: 'g', name: '好', savedAt: 5, profileJson: serializeProfile(factory()) }
    const backend = memoryBackend({
      [PROFILES_KEY]: doc('profiles', [good, { id: 'x' }, null, { ...good, id: '', name: 'no id' }, { ...good, id: 'b', savedAt: 'yesterday' }]),
    })
    const s = createLocalStore(backend)
    expect(await s.listProfiles()).toEqual([good])
    await s.listProfiles()
    expect(s.problems).toEqual(['有 4 条本地方案记录不完整，已忽略'])
    // the next write keeps only valid records
    await s.saveProfile('新', factory())
    expect(JSON.parse((await backend.get(PROFILES_KEY))!).items).toHaveLength(2)
  })

  it('reads a corrupt document as empty and sets the old text aside before overwriting it', async () => {
    for (const raw of ['{not json', JSON.stringify({ hello: 1 }), doc('backups', [])]) {
      const backend = memoryBackend({ [PROFILES_KEY]: raw })
      const s = createLocalStore(backend)
      expect(await s.listProfiles()).toEqual([])
      expect(s.problems.join()).toMatch(/损坏|格式不正确/)
      await s.saveProfile('新', factory())
      expect(await backend.get(`${PROFILES_KEY}.corrupt`)).toBe(raw)
      expect(await s.listProfiles()).toHaveLength(1)
    }
  })

  it('never overwrites a document written by a newer version', async () => {
    const backend = memoryBackend({ [PROFILES_KEY]: doc('profiles', [{ id: 'a', name: 'A', savedAt: 1, profileJson: '{}' }], 2) })
    const s = createLocalStore(backend)
    expect((await s.listProfiles()).map((p) => p.id)).toEqual(['a'])
    await expect(s.saveProfile('B', factory())).rejects.toMatchObject({ code: 'newer' })
    await expect(s.deleteProfile('a')).rejects.toMatchObject({ code: 'newer' })
  })

  it('loading a record whose JSON no longer validates returns the issues instead of a profile', async () => {
    const backend = memoryBackend({ [PROFILES_KEY]: doc('profiles', [{ id: 'a', name: 'A', savedAt: 1, profileJson: '{"format":"x"}' }]) })
    const res = await createLocalStore(backend).loadProfile('a')
    expect(res.profile).toBeNull()
    expect(res.issues.some((i) => i.severity === 'error')).toBe(true)
  })

  it('propagates backend read failures as StoreError', async () => {
    const backend: KvBackend = { ...memoryBackend(), get: () => Promise.reject(new StoreError('unavailable', '读取失败')) }
    await expect(createLocalStore(backend).listBackups()).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('automatic backups', () => {
  it(`keeps the newest ${BACKUP_LIMIT}, newest first, and restores them`, async () => {
    const s = createLocalStore(memoryBackend(), clockAndIds())
    const codes = ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'KeyM', 'KeyN', 'KeyO', 'KeyP', 'KeyQ', 'KeyR', 'KeyS', 'KeyT', 'KeyU', 'KeyV', 'KeyW', 'KeyX', 'KeyY']
    for (const c of codes) await s.addBackup(withCaps(c))
    const list = await s.listBackups()
    expect(list).toHaveLength(BACKUP_LIMIT)
    expect(list[0].note).toBe('写入前备份')
    expect(list.map((b) => b.savedAt)).toEqual([...list.map((b) => b.savedAt)].sort((a, b) => b - a))
    const newest = await s.restoreBackup(list[0].id)
    expect(newest.profile!.layers.base.caps).toEqual({ type: 'key', code: 'KeyY' })
    const oldest = await s.restoreBackup(list.at(-1)!.id)
    expect(oldest.profile!.layers.base.caps).toEqual({ type: 'key', code: 'KeyF' })

    await s.deleteBackup(list[0].id)
    expect(await s.listBackups()).toHaveLength(BACKUP_LIMIT - 1)
    await expect(s.restoreBackup(list[0].id)).rejects.toMatchObject({ code: 'not-found' })
  })

  it('does not add a duplicate of the newest backup', async () => {
    const s = createLocalStore(memoryBackend(), clockAndIds())
    const table = tableToProfile(FACTORY, { name: '键盘备份' })
    const a = await s.addBackup(table, '写入前备份')
    const b = await s.addBackup(tableToProfile(FACTORY, { name: '键盘备份' }))
    expect(b).toEqual(a)
    await s.addBackup(withCaps('KeyA'))
    await s.addBackup(table)
    expect(await s.listBackups()).toHaveLength(3)
  })

  it('honours a custom limit', async () => {
    const s = createLocalStore(memoryBackend(), { ...clockAndIds(), backupLimit: 2 })
    for (const c of ['KeyA', 'KeyB', 'KeyC']) await s.addBackup(withCaps(c), `n${c}`)
    expect((await s.listBackups()).map((b) => b.note)).toEqual(['nKeyC', 'nKeyB'])
  })

  it('drops older backups to make room when the storage is full', async () => {
    const ls = new FakeStorage()
    const s = createLocalStore((await detectBackend({ indexedDB: null, localStorage: ls })).backend, clockAndIds())
    for (const c of ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF']) await s.addBackup(withCaps(c))
    ls.quota = ls.map.get(BACKUPS_KEY)!.length + 10
    await s.addBackup(withCaps('KeyG'))
    const list = await s.listBackups()
    expect(list.length).toBeLessThan(7)
    expect(list[0].profileJson).toContain('"caps": "KeyG"')
    expect(s.problems.join()).toMatch(/已删除较早的备份/)
  })

  it('keeps simulator backups apart: they have their own limit and never push out keyboard backups', async () => {
    const s = createLocalStore(memoryBackend(), { ...clockAndIds(), backupLimit: 3 })
    for (const c of ['KeyA', 'KeyB', 'KeyC']) await s.addBackup(withCaps(c), `k${c}`)
    for (const c of ['KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH']) await s.addBackup(withCaps(c), `s${c}`, 'simulator')
    const list = await s.listBackups()
    expect(list.filter((b) => b.target === 'keyboard').map((b) => b.note)).toEqual(['kKeyC', 'kKeyB', 'kKeyA'])
    expect(list.filter((b) => b.target === 'simulator')).toHaveLength(Math.min(3, SIM_BACKUP_LIMIT))
    // The duplicate check only looks at the same target.
    const again = await s.addBackup(withCaps('KeyH'), 'kKeyH')
    expect(again.target).toBe('keyboard')
    expect((await s.listBackups()).filter((b) => b.target === 'keyboard')).toHaveLength(3)
  })

  it(`limits simulator backups to ${SIM_BACKUP_LIMIT}`, async () => {
    const s = createLocalStore(memoryBackend(), clockAndIds())
    for (let i = 0; i < SIM_BACKUP_LIMIT + 3; i++) await s.addBackup(withCaps(i % 2 ? 'KeyA' : 'KeyB'), `s${i}`, 'simulator')
    expect(await s.listBackups()).toHaveLength(SIM_BACKUP_LIMIT)
  })

  it('reads backups saved before the target field as keyboard backups', async () => {
    const old = { id: 'o', savedAt: 3, note: '旧', profileJson: serializeProfile(factory()) }
    const text = JSON.stringify({ format: 'plum-local', kind: 'backups', version: 1, items: [old] })
    const s = createLocalStore(memoryBackend({ [BACKUPS_KEY]: text }))
    expect((await s.listBackups())[0]).toMatchObject({ id: 'o', target: 'keyboard' })
  })

  it('on a full storage, drops simulator backups first and never keyboard backups for a simulator one', async () => {
    const ls = new FakeStorage()
    const s = createLocalStore((await detectBackend({ indexedDB: null, localStorage: ls })).backend, clockAndIds())
    for (const c of ['KeyA', 'KeyB', 'KeyC']) await s.addBackup(withCaps(c))
    for (const c of ['KeyD', 'KeyE']) await s.addBackup(withCaps(c), undefined, 'simulator')
    ls.quota = ls.map.get(BACKUPS_KEY)!.length + 10
    await s.addBackup(withCaps('KeyF'))
    let list = await s.listBackups()
    expect(list.map((b) => b.target)).toEqual(['keyboard', 'keyboard', 'keyboard', 'keyboard'])
    expect(s.problems.join()).toMatch(/已删除模拟键盘的备份/)

    ls.quota = ls.map.get(BACKUPS_KEY)!.length + 10
    await expect(s.addBackup(withCaps('KeyG'), undefined, 'simulator')).rejects.toMatchObject({ code: 'quota' })
    list = await s.listBackups()
    expect(list).toHaveLength(4)
  })

  it('runs operations one at a time', async () => {
    const s = createLocalStore(memoryBackend(), clockAndIds())
    await Promise.all(['KeyA', 'KeyB', 'KeyC', 'KeyD'].map((c) => s.addBackup(withCaps(c))))
    expect(await s.listBackups()).toHaveLength(4)
  })
})
