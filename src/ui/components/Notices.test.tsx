// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useCallback, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Notices, type Notice } from './Notices'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const n = (id: number, extra: Partial<Notice> = {}): Notice => ({ id, tone: 'info', title: `提示 ${id}`, ...extra })
const titles = () => [...document.querySelectorAll('.notice strong')].map((el) => el.textContent)
const card = (title: string) => screen.getByText(title).closest('.notice') as HTMLElement

/** Notices as App drives them: a dismissed notice goes, and every action closes its own notice first. */
function Stack({ initial }: { initial: Notice[] }) {
  const [items, setItems] = useState(initial)
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((x) => x.id !== id)), [])
  const shown = items.map((x) => ({
    ...x,
    actions: x.actions?.map((a) => ({
      label: a.label,
      onClick: () => {
        dismiss(x.id)
        a.onClick()
      },
    })),
  }))
  return (
    <>
      <button type="button">工具栏</button>
      <Notices items={shown} onDismiss={dismiss} fallbackFocus={() => screen.getByRole('button', { name: '工具栏' })} />
    </>
  )
}

describe('Notices', () => {
  it('keeps an empty live region, so the first notice is announced', () => {
    const { rerender } = render(<Notices items={[]} onDismiss={() => {}} />)
    const live = document.querySelector('[aria-live="polite"]')
    expect(live).not.toBeNull()
    expect(live?.children).toHaveLength(0)
    rerender(<Notices items={[n(1)]} onDismiss={() => {}} />)
    expect(document.querySelector('[aria-live="polite"]')).toBe(live)
    expect(screen.getByRole('status').textContent).toMatch('提示 1')
  })

  it('shows the two newest (newest lowest) and folds the rest into 还有 n 条', () => {
    // newest first, as App keeps them
    const { rerender } = render(<Notices items={[n(4), n(3), n(2), n(1)]} onDismiss={() => {}} />)
    expect(titles()).toEqual(['提示 3', '提示 4'])
    const more = screen.getByRole('button', { name: '还有 2 条' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(titles()).toEqual(['提示 1', '提示 2', '提示 3', '提示 4'])
    fireEvent.click(screen.getByRole('button', { name: '收起' }))
    expect(titles()).toEqual(['提示 3', '提示 4'])

    // no expander while everything fits; expanding does not stick past that
    fireEvent.click(screen.getByRole('button', { name: '还有 2 条' }))
    rerender(<Notices items={[n(4), n(3)]} onDismiss={() => {}} />)
    expect(screen.queryByRole('button', { name: /还有|收起/ })).toBeNull()
    rerender(<Notices items={[n(5), n(4), n(3)]} onDismiss={() => {}} />)
    expect(titles()).toEqual(['提示 4', '提示 5'])
  })

  it('runs actions and says which notice to close', () => {
    const onDismiss = vi.fn()
    const onUndo = vi.fn()
    render(<Notices items={[n(2, { tone: 'ok', actions: [{ label: '撤销', onClick: onUndo }] }), n(1, { tone: 'error', sticky: true })]} onDismiss={onDismiss} />)
    expect(screen.getByRole('alert').textContent).toMatch('提示 1')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(onUndo).toHaveBeenCalledTimes(1)
    fireEvent.click(within(card('提示 1')).getByRole('button', { name: '关闭提示' }))
    expect(onDismiss).toHaveBeenCalledWith(1)
  })

  it('gives focus to the next close button when a notice is closed, and to the fallback after the last', () => {
    render(<Stack initial={[n(2), n(1)]} />)
    const [older, newer] = screen.getAllByRole('button', { name: '关闭提示' })
    older.focus()
    fireEvent.click(older)
    expect(titles()).toEqual(['提示 2'])
    expect(document.activeElement).toBe(newer)
    fireEvent.click(newer)
    expect(titles()).toEqual([])
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '工具栏' }))
  })

  it('an action that closes its own notice hands focus on, never to <body> (review regression)', () => {
    render(<Stack initial={[n(2, { actions: [{ label: '撤销', onClick: () => {} }] }), n(1, { actions: [{ label: '重新读取', onClick: () => {} }] })]} />)
    const undo = screen.getByRole('button', { name: '撤销' })
    undo.focus()
    fireEvent.click(undo)
    // the older notice took the newest place: its first button
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '重新读取' }))
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '工具栏' }))
  })

  it('moves focus off 收起 when it goes away', () => {
    const { rerender } = render(<Notices items={[n(3), n(2), n(1)]} onDismiss={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '还有 1 条' }))
    screen.getByRole('button', { name: '收起' }).focus()
    rerender(<Notices items={[n(3), n(2)]} onDismiss={() => {}} />)
    expect(document.activeElement).toBe(within(card('提示 2')).getByRole('button', { name: '关闭提示' }))
  })

  it('closes by itself after its timeout, but never while it holds focus or the pointer (review regression)', () => {
    vi.useFakeTimers()
    render(<Stack initial={[n(1, { tone: 'ok', timeout: 1000, actions: [{ label: '撤销', onClick: () => {} }] })]} />)
    act(() => screen.getByRole('button', { name: '撤销' }).focus())
    act(() => vi.advanceTimersByTime(1500))
    expect(titles()).toEqual(['提示 1'])
    // The time starts again once focus leaves.
    act(() => screen.getByRole('button', { name: '工具栏' }).focus())
    act(() => vi.advanceTimersByTime(900))
    expect(titles()).toEqual(['提示 1'])
    fireEvent.mouseEnter(document.querySelector('.notice-stack')!)
    act(() => vi.advanceTimersByTime(1500))
    expect(titles()).toEqual(['提示 1'])
    fireEvent.mouseLeave(document.querySelector('.notice-stack')!)
    act(() => vi.advanceTimersByTime(1100))
    expect(titles()).toEqual([])
  })
})
