// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangeRow } from '../lib/changes'
import { SyncStatus } from './SyncStatus'

afterEach(cleanup)

type Props = ComponentProps<typeof SyncStatus>
const BASE: Props = { connected: true, read: true, unsaved: 0, errorCount: 0 }

const ROWS: ChangeRow[] = [
  { layer: 'base', keyId: 'caps', where: '基础层 · Caps Lock', from: 'Caps Lock', to: 'Esc' },
  { layer: 'fn', keyId: 'q', where: 'Fn 层 · Q', from: '无', to: 'Home' },
]

/** The pill's text as a sighted user reads it (the phone-width short form is aria-hidden). */
const pillText = () => document.querySelector('.sync-live .sync-text')?.textContent

describe('SyncStatus', () => {
  it.each<[string, Partial<Props>, string]>([
    ['errors first', { errorCount: 2, unsaved: 3, deviceStale: true }, '2 个错误，改正后才能写入'],
    ['a stale keyboard', { deviceStale: true, unsaved: 3, verified: true }, '键盘状态未知 · 建议重新读取'],
    ['offline', { connected: false, read: false }, '未连接键盘'],
    ['offline with edits (stale does not apply)', { connected: false, unsaved: 4, deviceStale: true }, '页面上有 4 处修改 · 未连接键盘'],
    ['not read yet', { read: false }, '还没读取键盘'],
    ['not read yet, with edits', { read: false, unsaved: 1 }, '页面上有 1 处修改 · 写入前会先读取键盘'],
    ['unwritten changes', { unsaved: 5, verified: true }, '5 处修改未写入'],
    ['a verified write', { verified: true }, '已写入并校验'],
    ['in sync', {}, '与键盘一致'],
  ])('shows %s', (_, props, text) => {
    render(<SyncStatus {...BASE} {...props} />)
    expect(pillText()).toBe(text)
  })

  it('opens the issues on the error pill, or scrolls to #issues without a handler', () => {
    const onShowErrors = vi.fn()
    const { rerender } = render(<SyncStatus {...BASE} errorCount={1} onShowErrors={onShowErrors} />)
    fireEvent.click(screen.getByRole('button', { name: /1 个错误，改正后才能写入/ }))
    expect(onShowErrors).toHaveBeenCalledTimes(1)

    const target = document.createElement('section')
    target.id = 'issues'
    target.scrollIntoView = vi.fn()
    document.body.append(target)
    rerender(<SyncStatus {...BASE} errorCount={1} />)
    fireEvent.click(screen.getByRole('button', { name: /个错误/ }))
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
    target.remove()
  })

  it('re-reads from the stale pill', () => {
    const onReread = vi.fn()
    render(<SyncStatus {...BASE} deviceStale onReread={onReread} />)
    fireEvent.click(screen.getByRole('button', { name: /键盘状态未知/ }))
    expect(onReread).toHaveBeenCalledTimes(1)
  })

  it('is an aria-disabled button that does nothing when there is nothing to do', () => {
    const onReread = vi.fn()
    render(<SyncStatus {...BASE} onReread={onReread} />)
    const pill = screen.getByRole('button', { name: '与键盘一致' })
    expect(pill.getAttribute('aria-disabled')).toBe('true')
    expect(pill.hasAttribute('aria-haspopup')).toBe(false)
    fireEvent.click(pill)
    expect(onReread).not.toHaveBeenCalled()
  })

  it('keeps focus on the pill when its re-read succeeds', () => {
    const onReread = vi.fn()
    const { rerender } = render(<SyncStatus {...BASE} deviceStale onReread={onReread} />)
    const pill = screen.getByRole('button', { name: '键盘状态未知 · 建议重新读取' })
    expect(pill.hasAttribute('aria-disabled')).toBe(false)
    pill.focus()
    rerender(<SyncStatus {...BASE} onReread={onReread} />)
    expect(document.activeElement).toBe(pill)
    expect(pill.getAttribute('aria-disabled')).toBe('true')
    expect(pillText()).toBe('与键盘一致')
  })

  it('keeps focus when the unwritten changes are undone, also from inside their list', () => {
    const props = { ...BASE, unsaved: 2, pendingRows: ROWS, onSelectKey: () => {} }
    const { rerender } = render(<SyncStatus {...props} />)
    const pill = screen.getByRole('button', { name: '2 处修改未写入' })
    pill.focus()
    rerender(<SyncStatus {...props} unsaved={0} pendingRows={[]} />)
    expect(document.activeElement).toBe(pill)
    expect(pill.hasAttribute('aria-haspopup')).toBe(false)

    rerender(<SyncStatus {...props} />)
    fireEvent.click(pill)
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0])
    rerender(<SyncStatus {...props} unsaved={0} pendingRows={[]} />)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(pill)
  })

  it('lists the unwritten changes like a menu; a row selects its key', () => {
    const onSelectKey = vi.fn()
    render(<SyncStatus {...BASE} unsaved={2} pendingRows={ROWS} onSelectKey={onSelectKey} />)
    const pill = screen.getByRole('button', { name: '2 处修改未写入' })
    expect(pill.getAttribute('aria-haspopup')).toBe('menu')
    fireEvent.click(pill)
    expect(pill.getAttribute('aria-expanded')).toBe('true')
    const menu = screen.getByRole('menu', { name: '未写入的修改' })
    expect(pill.getAttribute('aria-controls')).toBe(menu.id)
    // the list is not inside the live region: opening it is not announced as a status change
    expect(menu.closest('[aria-live]')).toBeNull()
    expect(pill.closest('[aria-live]')).not.toBeNull()

    const items = screen.getAllByRole('menuitem')
    expect(items.map((i) => [i.querySelector('.sync-where')?.textContent, i.querySelector('small')?.textContent])).toEqual([
      ['基础层 · Caps Lock', 'Caps Lock → Esc'],
      ['Fn 层 · Q', '无 → Home'],
    ])
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(items[1], { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(pill)

    fireEvent.click(pill)
    fireEvent.click(screen.getByRole('menuitem', { name: /Fn 层 · Q/ }))
    expect(onSelectKey).toHaveBeenCalledWith('fn', 'q')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(pill)
  })

  it('closes the list when the state moves on', () => {
    const props = { ...BASE, unsaved: 2, pendingRows: ROWS, onSelectKey: () => {} }
    const { rerender } = render(<SyncStatus {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /处修改未写入/ }))
    expect(screen.getByRole('menu')).toBeTruthy()
    rerender(<SyncStatus {...props} unsaved={0} pendingRows={[]} verified />)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(pillText()).toBe('已写入并校验')
    rerender(<SyncStatus {...props} />)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps the count as the only visible text at phone width, the full text for screen readers', () => {
    render(<SyncStatus {...BASE} unsaved={7} />)
    const short = document.querySelector('.sync-short')
    expect(short?.textContent).toBe('7')
    expect(short?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByText('7 处修改未写入')).toBeTruthy()
  })
})
