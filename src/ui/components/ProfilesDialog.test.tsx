// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { factoryDraft, type Draft } from '../state/editor'
import { createLocalStore, memoryBackend, type LocalStore } from '../state/localStore'
import { ProfilesDialog, type ProfilesDialogProps } from './ProfilesDialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function draftWith(code: string): Draft {
  const d = factoryDraft()
  d.layers.base.caps = { type: 'key', code }
  return d
}

let t = Date.parse('2026-10-31T09:05:07')
const newStore = () => createLocalStore(memoryBackend(), { now: () => (t += 60_000) })

function setup(props: Partial<ProfilesDialogProps> & { store: LocalStore }) {
  const onLoad = vi.fn()
  const onRestoreBackup = vi.fn()
  const onClose = vi.fn()
  render(<ProfilesDialog open current={draftWith('Escape')} onLoad={onLoad} onRestoreBackup={onRestoreBackup} onClose={onClose} {...props} />)
  return { onLoad, onRestoreBackup, onClose }
}

function captureDownload(): Promise<{ name: string; text: string }> {
  return new Promise((resolve) => {
    let blob: Blob
    URL.createObjectURL = vi.fn((b: Blob) => ((blob = b), 'blob:test'))
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      void blob.text().then((text) => resolve({ name: this.download, text }))
    })
  })
}

describe('ProfilesDialog', () => {
  it('renders nothing when closed', () => {
    render(<ProfilesDialog open={false} current={factoryDraft()} onLoad={() => {}} onRestoreBackup={() => {}} onClose={() => {}} store={newStore()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('saves the current draft, loads it back and closes', async () => {
    const store = newStore()
    const { onLoad, onClose } = setup({ store })
    expect(screen.getByRole('dialog', { name: '方案' })).toBeTruthy()
    expect(await screen.findByText('还没有保存的方案。')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('把页面上的键位保存为方案'), { target: { value: '办公' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存$/ }))
    const list = await screen.findByRole('list', { name: '已保存的方案' })
    expect(within(list).getByText('办公')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('已保存方案“办公”')
    // same name -> overwrite
    expect(screen.getByRole('button', { name: /覆盖同名方案/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '载入方案“办公”到页面' }))
    await waitFor(() => expect(onLoad).toHaveBeenCalled())
    expect(onLoad.mock.calls[0][0].layers.base.caps).toEqual({ type: 'key', code: 'Escape' })
    expect(onLoad.mock.calls[0][0].name).toBe('办公')
    expect(onLoad.mock.calls[0][1]).toMatchObject({ name: '办公' })
    expect(onClose).toHaveBeenCalled()
  })

  it('renames, exports and deletes (with confirmation) a profile', async () => {
    const store = newStore()
    await store.saveProfile('游戏', draftWith('KeyA'))
    setup({ store })
    fireEvent.click(await screen.findByRole('button', { name: '重命名方案“游戏”' }))
    const input = screen.getByRole('textbox', { name: '方案“游戏”的新名称' })
    fireEvent.change(input, { target: { value: '射击游戏' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('射击游戏')).toBeTruthy()
    expect((await store.listProfiles())[0].name).toBe('射击游戏')

    const dl = captureDownload()
    fireEvent.click(screen.getByRole('button', { name: '导出方案“射击游戏”' }))
    const file = await dl
    expect(file.name).toMatch(/^射击游戏-\d{8}-\d{4}\.json$/)
    expect(JSON.parse(file.text).layers.base.caps).toBe('KeyA')

    fireEvent.click(screen.getByRole('button', { name: '删除方案“射击游戏”' }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除方案“射击游戏”' }))
    expect(await screen.findByText('还没有保存的方案。')).toBeTruthy()
    expect(await store.listProfiles()).toEqual([])
    // The row and its focused button are gone: focus stays in the dialog, on the current tab.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: /已保存的方案/ })))
  })

  it('does not save a draft with errors', async () => {
    const bad = factoryDraft()
    bad.layers.base.caps = { type: 'combo', keys: ['KeyA'] }
    setup({ store: newStore(), current: bad })
    await screen.findByText('还没有保存的方案。')
    fireEvent.change(screen.getByLabelText('把页面上的键位保存为方案'), { target: { value: 'x' } })
    expect((screen.getByRole('button', { name: /^保存$/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/页面上的键位有 1 个错误/)).toBeTruthy()
  })

  it('lists automatic backups and loads one onto the page', async () => {
    const store = newStore()
    await store.addBackup(draftWith('KeyB'))
    await store.addBackup(draftWith('KeyC'))
    const { onRestoreBackup, onClose } = setup({ store })
    const tab = screen.getByRole('tab', { name: /自动备份/ })
    fireEvent.click(tab)
    expect(tab.getAttribute('aria-selected')).toBe('true')
    const list = await screen.findByRole('list', { name: '自动备份' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('写入之前 · 1 处与出厂不同')).toBeTruthy()
    expect(within(rows[0]).getByText(/^2026-10-31 \d\d:\d\d:\d\d$/)).toBeTruthy()
    // only the newest one is 最近一次
    expect(within(rows[0]).getByText('最近一次')).toBeTruthy()
    expect(within(rows[1]).queryByText('最近一次')).toBeNull()

    const dl = captureDownload()
    fireEvent.click(within(rows[1]).getByRole('button', { name: /导出 .* 的备份/ }))
    expect(JSON.parse((await dl).text).layers.base.caps).toBe('KeyB')

    fireEvent.click(within(rows[0]).getByRole('button', { name: /^载入 .* 的备份到页面$/ }))
    await waitFor(() => expect(onRestoreBackup).toHaveBeenCalled())
    expect(onRestoreBackup.mock.calls[0][0].layers.base.caps).toEqual({ type: 'key', code: 'KeyC' })
    expect(onRestoreBackup.mock.calls[0][1]).toMatchObject({ note: '写入前备份' })
    expect(onClose).toHaveBeenCalled()
  })

  it('marks simulator backups and the newest backup of each kind, and keeps focus on the tab after a delete', async () => {
    const store = newStore()
    await store.addBackup(factoryDraft())
    await store.addBackup(draftWith('KeyD'), '写入前自动备份', 'simulator')
    setup({ store, initialTab: 'backups' })
    const rows = within(await screen.findByRole('list', { name: '自动备份' })).getAllByRole('listitem')
    expect(within(rows[0]).getByText('模拟键盘')).toBeTruthy()
    expect(within(rows[0]).getByText('最近一次')).toBeTruthy()
    expect(within(rows[1]).queryByText('模拟键盘')).toBeNull()
    expect(within(rows[1]).getByText('写入之前 · 出厂键位')).toBeTruthy()
    // the keyboard's own newest backup is also its 最近一次, even below a newer simulator backup
    expect(within(rows[1]).getByText('最近一次')).toBeTruthy()

    fireEvent.click(within(rows[1]).getByRole('button', { name: /^删除 .* 的备份$/ }))
    fireEvent.click(within(rows[1]).getByRole('button', { name: /^确认删除 .* 的备份$/ }))
    await waitFor(() => expect(within(screen.getByRole('list', { name: '自动备份' })).getAllByRole('listitem')).toHaveLength(1))
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /自动备份/ }))
  })

  it('switches tabs with the arrow keys', async () => {
    setup({ store: newStore(), initialTab: 'backups' })
    expect(await screen.findByText('还没有自动备份。')).toBeTruthy()
    const backups = screen.getByRole('tab', { name: /自动备份/ })
    expect(backups.tabIndex).toBe(0)
    fireEvent.keyDown(backups, { key: 'ArrowLeft' })
    const profiles = screen.getByRole('tab', { name: /已保存的方案/ })
    expect(profiles.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(profiles)
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(profiles.id)
  })

  it('warns when only memory storage is available and shows store errors', async () => {
    const store = newStore()
    store.saveProfile = () => Promise.reject(new Error('写入出错'))
    setup({ store })
    expect(await screen.findByText(/刷新或关闭后会丢失/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('把页面上的键位保存为方案'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存$/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('写入出错')
  })

  it('opens the store lazily from a promise', async () => {
    render(<ProfilesDialog open current={factoryDraft()} onLoad={() => {}} onRestoreBackup={() => {}} onClose={() => {}} store={Promise.resolve(newStore())} />)
    expect(await screen.findByText('还没有保存的方案。')).toBeTruthy()
  })
})
