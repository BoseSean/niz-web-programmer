// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodePicker } from './CodePicker'

afterEach(cleanup)

const option = (name: RegExp) => screen.queryByRole('option', { name })
const tabs = () => within(screen.getByRole('tablist', { name: '代码分类' })).getAllByRole('tab').map((t) => t.textContent)
const search = () => screen.getByRole('searchbox', { name: '搜索按键代码' })

describe('CodePicker', () => {
  it('hides codes that do nothing or are unverified on the 84EC-S until asked', () => {
    render(<CodePicker onPick={() => {}} />)
    expect((search() as HTMLInputElement).placeholder).toBe('搜索：名称、英文或代码，如 音量、Esc、0xA2')
    expect(option(/背光亮度\+/)).toBeNull()
    expect(option(/背光开关/)).toBeNull()
    expect(option(/设备功能 0xA2/)).toBeNull()
    expect(tabs()).not.toContain('未知功能')
    expect(tabs()).toContain('键盘功能')
    // documented in the 84EC-S manual, so it stays (without a badge)
    const rowLock = option(/数字行锁定/)!
    expect(rowLock.classList.contains('is-uncertain')).toBe(false)
    expect(option(/锁定 Win 键/)).toBeTruthy()

    const more = screen.getByRole('button', { name: /^显示 \d+ 个无效或作用未知的代码（背光、未知功能等）$/ })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(tabs()).toContain('未知功能')
    const light = option(/背光开关/)!
    expect(light.classList.contains('is-uncertain')).toBe(true)
    expect(light.textContent).toContain('84EC-S 没有背光，按下无效果')
    expect(light.textContent).toContain('无效')
    expect(option(/背光亮度\+/)!.textContent).toContain('在 84EC-S 上的作用未验证')
    fireEvent.click(screen.getByRole('button', { name: '隐藏无效或作用未知的代码' }))
    expect(option(/背光开关/)).toBeNull()
  })

  it('always lists the current value, even a hidden one', () => {
    render(<CodePicker value="BacklightUp" onPick={() => {}} />)
    const current = option(/背光亮度\+/)!
    expect(current.getAttribute('aria-selected')).toBe('true')
    expect(current.textContent).toContain('?')
    expect(option(/背光亮度−/)).toBeNull()
  })

  it('keeps the 未知功能 tab while the current value is one of them', () => {
    render(<CodePicker value="DeviceA2" onPick={() => {}} />)
    expect(tabs()).toContain('未知功能')
    fireEvent.click(screen.getByRole('tab', { name: '未知功能' }))
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /^显示 5 个/ })).toBeTruthy()
  })

  it('finds hidden codes by search (0xA2 from the key tester guide) and Enter prefers a working code', () => {
    const onPick = vi.fn()
    render(<CodePicker onPick={onPick} />)
    fireEvent.change(search(), { target: { value: '0xA2' } })
    const a2 = option(/设备功能 0xA2/)!
    expect(a2.textContent).toContain('在 84EC-S 上的作用未验证')
    expect(screen.queryByRole('button', { name: /^显示/ })).toBeNull()
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(onPick).toHaveBeenLastCalledWith('DeviceA2')

    // "mode" finds 日落/放松模式 (unverified) before 办公/编程模式切换; Enter takes the one that works
    fireEvent.change(search(), { target: { value: 'mode' } })
    expect(screen.getAllByRole('option').map((o) => o.querySelector('.picker-name')!.textContent)).toEqual(['日落/放松模式', '办公/编程模式切换'])
    fireEvent.keyDown(search(), { key: 'Enter' })
    expect(onPick).toHaveBeenLastCalledWith('ProgramMode')
  })
})
