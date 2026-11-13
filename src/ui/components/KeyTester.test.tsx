// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { factoryTable, keyById } from '../../device/layout'
import { KeyTesterPanel } from './KeyTester'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const press = (type: 'keydown' | 'keyup', code: string, key = code, extra: KeyboardEventInit = {}) =>
  act(() => void window.dispatchEvent(new KeyboardEvent(type, { code, key, bubbles: true, cancelable: true, ...extra })))

function setup(active = true) {
  const onClose = vi.fn()
  const onHighlight = vi.fn<(ids: string[]) => void>()
  const view = render(<KeyTesterPanel active={active} onClose={onClose} onHighlight={onHighlight} />)
  return { onClose, onHighlight, view }
}

const lastHighlight = (fn: { mock: { calls: string[][][] } }) => fn.mock.calls.at(-1)?.[0]

describe('KeyTesterPanel', () => {
  it('shows the live state, the last key, held keys and highlights the physical key', () => {
    const { onHighlight } = setup()
    expect(screen.getByText('正在测试，直接按键盘')).toBeTruthy()
    // The board is not always to the left (it stacks above at ≤980px).
    expect(screen.getByText(/按下的键会在键盘图上亮起/)).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByLabelText(/按键测试区/))

    press('keydown', 'CapsLock', 'CapsLock')
    const last = document.querySelector('.kt-last') as HTMLElement
    expect(within(last).getByText('大写锁定 (Caps Lock)')).toBeTruthy()
    expect(within(last).getByText('键盘上的 Caps Lock')).toBeTruthy()
    // codes are folded under 详细, outside the live region
    expect(within(last).queryByText('0x2A')).toBeNull()
    const more = screen.getByText('详细').closest('details')!
    expect(more.open).toBe(false)
    fireEvent.click(screen.getByText('详细'))
    expect(more.open).toBe(true)
    expect(within(more).getByText('0x2A')).toBeTruthy()
    expect(within(more).getByText('CapsLock')).toBeTruthy()
    expect(within(screen.getByRole('list', { name: '当前按住的键' })).getByText('大写锁定 (Caps Lock)')).toBeTruthy()
    expect(lastHighlight(onHighlight)).toEqual(['caps'])

    press('keydown', 'ControlRight', 'Control', { location: 2 })
    expect(lastHighlight(onHighlight)).toEqual(['caps', 'rctrl'])

    press('keyup', 'CapsLock', 'CapsLock')
    press('keyup', 'ControlRight', 'Control', { location: 2 })
    expect(within(screen.getByRole('list', { name: '当前按住的键' })).getByText('无')).toBeTruthy()
    // a short flash keeps the latest press lit, then it goes dark
    act(() => void vi.advanceTimersByTime(1000))
    expect(lastHighlight(onHighlight)).toEqual([])
  })

  it('names the map it looked the key up in', () => {
    const { view } = setup()
    // the factory map has no Num Lock on the base layer
    press('keydown', 'NumLock', 'NumLock')
    expect(screen.getByText(/出厂键位里没有产生它的键/)).toBeTruthy()

    // after a read: the keyboard's map, here with Caps Lock remapped to Esc
    const table = factoryTable()
    table.base[keyById('caps')!.no - 1] = { kind: 'codes', codes: [1] }
    view.rerender(<KeyTesterPanel active onClose={() => {}} table={table} />)
    press('keydown', 'CapsLock', 'CapsLock')
    expect(screen.getByText(/键盘里的键位中没有产生它的键/)).toBeTruthy()
    expect(screen.queryByText(/出厂键位/)).toBeNull()
    press('keydown', 'Escape', 'Escape')
    expect(screen.getByText('键盘上的 Esc / Caps Lock')).toBeTruthy()
  })

  it('logs a timeline with down/up and counts', () => {
    setup()
    press('keydown', 'KeyA', 'a')
    press('keyup', 'KeyA', 'a')
    const log = screen.getByRole('list', { name: /事件记录/ })
    const rows = within(log).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    // newest first
    expect(within(rows[0]).getByLabelText('松开')).toBeTruthy()
    expect(within(rows[1]).getByLabelText('按下')).toBeTruthy()
    expect(within(rows[1]).getByText('—')).toBeTruthy()
    expect(rows[0].textContent).toMatch(/按住 \d+ ms/)
    const stats = screen.getByLabelText('统计')
    expect(within(stats).getByText('按下').nextSibling!.textContent).toBe('1')
    expect(within(stats).getByText('松开').nextSibling!.textContent).toBe('1')
  })

  it('shows mouse buttons and the wheel by name', () => {
    setup()
    act(() => void window.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true })))
    expect(screen.getAllByText('鼠标右键').length).toBeGreaterThan(0)
    act(() => void window.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true })))
    act(() => void window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true })))
    expect(screen.getAllByText('滚轮向下').length).toBeGreaterThan(0)
  })

  it('hides auto-repeat on request', () => {
    setup()
    press('keydown', 'KeyK', 'k')
    press('keydown', 'KeyK', 'k', { repeat: true })
    press('keydown', 'KeyK', 'k', { repeat: true })
    const log = () => within(screen.getByRole('list', { name: /事件记录/ })).getAllByRole('listitem')
    expect(log()).toHaveLength(3)
    expect(screen.getByText(/自动重复 2 次/)).toBeTruthy()
    expect(within(screen.getByLabelText('统计')).getByText('自动重复').nextSibling!.textContent).toBe('2')
    fireEvent.click(screen.getByLabelText('显示自动重复'))
    expect(log()).toHaveLength(1)
  })

  it('clears, pauses and closes', () => {
    const { onClose } = setup()
    press('keydown', 'KeyQ', 'q')
    press('keyup', 'KeyQ', 'q')
    fireEvent.click(screen.getByRole('button', { name: /清空/ }))
    expect(screen.getByText(/还没有收到按键/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    expect(screen.getByText('测试已暂停')).toBeTruthy()
    press('keydown', 'KeyQ', 'q')
    expect(screen.getByText(/还没有收到按键/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续测试' }))
    press('keydown', 'KeyW', 'w')
    expect(document.querySelector('.kt-last-zh')!.textContent).toBe('W')

    fireEvent.click(screen.getByRole('button', { name: '关闭按键测试' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('records a single Esc and closes on two Esc presses in a row (one while paused)', () => {
    const { onClose } = setup()
    press('keydown', 'Escape', 'Escape')
    press('keyup', 'Escape', 'Escape')
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('.kt-last-zh')!.textContent).toMatch(/Esc/)
    act(() => void vi.advanceTimersByTime(2000))
    press('keydown', 'Escape', 'Escape')
    expect(onClose).not.toHaveBeenCalled()
    act(() => void vi.advanceTimersByTime(200))
    press('keydown', 'Escape', 'Escape')
    expect(onClose).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    press('keydown', 'Escape', 'Escape')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('does not capture while inactive and clears the highlight on unmount', () => {
    const { onHighlight, view } = setup(false)
    expect(screen.getByText('测试未开启')).toBeTruthy()
    const e = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })
    act(() => void window.dispatchEvent(e))
    expect(e.defaultPrevented).toBe(false)
    expect(screen.getByText(/还没有收到按键/)).toBeTruthy()

    view.rerender(<KeyTesterPanel active onClose={() => {}} onHighlight={onHighlight} />)
    press('keydown', 'KeyA', 'a')
    expect(lastHighlight(onHighlight)).toEqual(['a'])
    view.unmount()
    expect(lastHighlight(onHighlight)).toEqual([])
  })

  it('explains what is blocked and how to probe unknown functions', () => {
    setup()
    expect(screen.getByText(/如何试出未知功能/)).toBeTruthy()
    expect(screen.getByText(/写入前会自动备份/).textContent).toContain('“方案”里导出文件')
    expect(screen.getByText(/永远不会拦截/).textContent).toContain('Alt+F4')
    expect(screen.getByText(/由操作系统直接处理/).textContent).toContain('计算器')
  })
})
