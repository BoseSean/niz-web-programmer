// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PacketLog } from '../state/packetLog'
import { PacketLogDrawer } from './PacketLog'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('PacketLogDrawer', () => {
  it('renders nothing when hidden', () => {
    const { container } = render(<PacketLogDrawer log={new PacketLog()} visible={false} />)
    expect(container.innerHTML).toBe('')
  })

  it('is the 通信日志 tab; the count shows only when it is open', () => {
    vi.useFakeTimers()
    const log = new PacketLog()
    render(<PacketLogDrawer log={log} />)
    expect(screen.getByRole('region', { name: '通信日志' })).toBeTruthy()
    const tab = screen.getByRole('button', { name: '通信日志' })
    expect(tab.getAttribute('aria-expanded')).toBe('false')

    act(() => {
      log.listener('out', new Uint8Array(64))
      vi.advanceTimersByTime(100)
    })
    expect(tab.textContent).toBe('通信日志')
    fireEvent.click(tab)
    expect(tab.getAttribute('aria-expanded')).toBe('true')
    expect(tab.textContent).toBe('通信日志1')

    act(() => log.clear())
    expect(screen.getByText('还没有记录。读取或写入时，收发的原始数据会显示在这里。')).toBeTruthy()
  })
})
