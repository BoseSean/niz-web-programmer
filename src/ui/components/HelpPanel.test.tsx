// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HelpPanel } from './HelpPanel'

afterEach(cleanup)

describe('HelpPanel', () => {
  it('uses the current names for the tools it explains', () => {
    render(<HelpPanel onClose={() => {}} />)
    const text = screen.getByRole('dialog', { name: '使用说明' }).textContent ?? ''
    expect(text).toMatch('键盘复位')
    expect(text).toMatch('键盘图旁的“⋯”菜单 → 全部清空')
    expect(text).toMatch('方案 → 自动备份')
    expect(text).toMatch('连发')
    expect(text).not.toMatch(/模拟击键|方案与备份|文件 →|恢复出厂：|编辑区|报文/)
    // At ≤980px the inspector sits under the board: no 右侧 / 右上角 for where things are on the page.
    expect(text).not.toMatch(/在右侧|右上角的“⋯/)
    // no log toggle without a handler
    expect(screen.queryByRole('button', { name: /通信日志/ })).toBeNull()
  })

  it('shows or hides the 通信日志', () => {
    const onToggleLog = vi.fn()
    const { rerender } = render(<HelpPanel onClose={() => {}} logVisible={false} onToggleLog={onToggleLog} />)
    fireEvent.click(screen.getByRole('button', { name: '显示通信日志（排查问题时用）' }))
    expect(onToggleLog).toHaveBeenCalledTimes(1)
    rerender(<HelpPanel onClose={() => {}} logVisible onToggleLog={onToggleLog} />)
    expect(screen.getByRole('button', { name: '隐藏通信日志' })).toBeTruthy()
  })
})
