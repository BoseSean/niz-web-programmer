// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComboEditor, EmulateEditor } from './ComboEmulate'
import { RawView } from './RawView'

afterEach(cleanup)

describe('combo and 连发 editors', () => {
  it('counts the keys a combo still needs, then the room left', () => {
    const { rerender } = render(<ComboEditor action={{ type: 'combo', keys: ['KeyA'] }} onChange={() => {}} />)
    expect(screen.getByText('还差 1 个键')).toBeTruthy()
    expect(screen.getByRole('button', { name: '用键盘录入组合键' })).toBeTruthy()
    expect(document.querySelector('.lead')).toBeNull()
    rerender(<ComboEditor action={{ type: 'combo', keys: ['ControlLeft', 'KeyC'] }} onChange={() => {}} />)
    expect(screen.getByText('2 / 6')).toBeTruthy()
  })

  it('names the 连发 interval and says which way it goes', () => {
    const onChange = vi.fn()
    render(<EmulateEditor action={{ type: 'emulate', keys: [], interval: 30 }} onChange={onChange} />)
    expect(screen.getByText('还差 1 个键')).toBeTruthy()
    expect(screen.getByRole('button', { name: '用键盘录入要连发的键' })).toBeTruthy()
    expect(screen.getByText('数值越大越慢（单位未确认，可能是毫秒）。KB84 默认 30。')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('连发间隔'), { target: { value: '60' } })
    expect(onChange).toHaveBeenLastCalledWith({ type: 'emulate', keys: [], interval: 60 }, 'emulate-interval')
  })
})

describe('RawView', () => {
  it('keeps the packets under 技术细节', () => {
    render(<RawView action={{ type: 'raw', packets: ['00F00236'.padEnd(128, '0')] }} />)
    const details = screen.getByText('技术细节').closest('details')!
    expect(details.open).toBe(false)
    expect(details.contains(screen.getByLabelText('数据包 1'))).toBe(true)
    expect(details.textContent).toMatch(/续包/)
  })
})
