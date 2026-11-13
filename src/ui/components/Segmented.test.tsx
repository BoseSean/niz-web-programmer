// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Segmented, type SegmentOption } from './Segmented'

afterEach(cleanup)

type Fruit = 'apple' | 'pear' | 'plum' | 'fig'
const OPTIONS: SegmentOption<Fruit>[] = [
  { value: 'apple', label: '苹果' },
  { value: 'pear', label: '梨', disabled: true },
  { value: 'plum', label: '李子' },
  { value: 'fig', label: '无花果' },
]

/** Keeps the value in state like the real callers; `log` sees every change. */
function Harness({ log, ...rest }: { log?: (v: Fruit) => void } & Partial<ComponentProps<typeof Segmented<Fruit>>>) {
  const [value, setValue] = useState<Fruit>('apple')
  return (
    <Segmented<Fruit>
      label="水果"
      value={value}
      options={OPTIONS}
      onChange={(v) => {
        log?.(v)
        setValue(v)
      }}
      {...rest}
    />
  )
}

const radio = (name: string) => screen.getByRole('radio', { name })
const checked = () => screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.textContent)
const key = (k: string) => fireEvent.keyDown(document.activeElement!, { key: k })

describe('Segmented', () => {
  it('has one tab stop, on the checked option', () => {
    render(<Harness />)
    expect(screen.getByRole('radiogroup', { name: '水果' })).toBeTruthy()
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1, -1, -1])
    fireEvent.click(radio('无花果'))
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([-1, -1, -1, 0])
  })

  it('moves focus with the arrows, Home and End, skipping disabled options; Space / Enter (a click) selects', () => {
    const log = vi.fn()
    render(<Harness log={log} />)
    radio('苹果').focus()
    key('ArrowRight')
    expect(document.activeElement).toBe(radio('李子'))
    key('ArrowDown')
    expect(document.activeElement).toBe(radio('无花果'))
    key('ArrowRight') // wraps
    expect(document.activeElement).toBe(radio('苹果'))
    key('ArrowLeft')
    expect(document.activeElement).toBe(radio('无花果'))
    key('Home')
    expect(document.activeElement).toBe(radio('苹果'))
    key('End')
    expect(document.activeElement).toBe(radio('无花果'))
    key('ArrowUp')
    expect(document.activeElement).toBe(radio('李子'))
    // manual by default: moving focus selects nothing (动作类型 / 按键之间 convert the action when selected)
    expect(log).not.toHaveBeenCalled()
    expect(checked()).toEqual(['苹果'])

    fireEvent.click(document.activeElement!)
    expect(log).toHaveBeenCalledWith('plum')
    expect(checked()).toEqual(['李子'])
  })

  it('also selects on the arrows with activation="auto"', () => {
    const log = vi.fn()
    render(<Harness log={log} activation="auto" />)
    radio('苹果').focus()
    key('ArrowRight')
    expect(document.activeElement).toBe(radio('李子'))
    expect(checked()).toEqual(['李子'])
    key('End')
    expect(log.mock.calls).toEqual([['plum'], ['fig']])
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([-1, -1, -1, 0])
  })

  it('ignores other keys and leaves the tab stop on an enabled option when the checked one is disabled', () => {
    render(<Harness value="pear" />)
    expect(screen.getAllByRole('radio').map((r) => r.tabIndex)).toEqual([0, -1, -1, -1])
    radio('苹果').focus()
    expect(fireEvent.keyDown(radio('苹果'), { key: 'Tab' })).toBe(true) // not prevented
    expect(fireEvent.keyDown(radio('苹果'), { key: 'ArrowLeft', altKey: true })).toBe(true) // the browser's Back
    expect(document.activeElement).toBe(radio('苹果'))
  })
})
