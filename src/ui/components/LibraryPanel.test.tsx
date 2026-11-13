// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Action } from '../../format/types'
import { factoryDraft, type Draft } from '../state/editor'
import { addToLibrary, libraryEntries } from '../state/library'
import { LibraryPanel, type LibraryPanelProps } from './LibraryPanel'

afterEach(cleanup)

const copy: Action = { type: 'combo', keys: ['ControlLeft', 'KeyC'] }
const macro: Action = { type: 'macro', play: 'repeat', repeat: 1, interval: 30, steps: [{ tap: 'KeyH' }, { tap: 'KeyI' }] }
const emu: Action = { type: 'emulate', keys: ['KeyZ'], interval: 50 }

function libDraft(): Draft {
  let d = factoryDraft()
  for (const a of [copy, macro]) d = addToLibrary(d, a).draft
  d.layers.base.f1 = structuredClone(copy)
  d.layers.fn.f2 = structuredClone(copy)
  return d
}

/** Renders the panel with its draft kept in state, like App would through the editor reducer. */
function Harness(props: Partial<LibraryPanelProps> & { initial: Draft; log?: (label: string, d: Draft) => void }) {
  const [draft, setDraft] = useState(props.initial)
  return (
    <LibraryPanel
      draft={draft}
      onApply={props.onApply ?? (() => {})}
      selectedAction={props.selectedAction}
      selectedLabel={props.selectedLabel}
      onSelectKey={props.onSelectKey}
      onChange={(d, label) => {
        props.log?.(label, d)
        setDraft(d)
      }}
    />
  )
}

describe('LibraryPanel', () => {
  it('explains the library when it is empty', () => {
    render(<Harness initial={factoryDraft()} />)
    expect(screen.getByRole('heading', { name: '动作库' })).toBeTruthy()
    expect(screen.getByText(/相当于 KB84 的预定义列表/)).toBeTruthy()
    expect(screen.getByText('随方案一起保存和导出，不写入键盘')).toBeTruthy()
    const add = screen.getByRole('button', { name: /存入动作库/ })
    expect((add as HTMLButtonElement).disabled).toBe(true)
    expect(add.title).toMatch(/先选择/)
  })

  it('creates an entry from the selected key with a KB84-style name', () => {
    const log = vi.fn()
    render(<Harness initial={factoryDraft()} selectedAction={emu} selectedLabel="基础层 · Caps" log={log} />)
    fireEvent.click(screen.getByRole('button', { name: /存入动作库/ }))
    expect(log).toHaveBeenCalledWith('动作库：新建“连发1”', expect.anything())
    expect(libraryEntries(log.mock.calls[0][1], 'emulates')).toEqual([{ name: '连发1', action: emu }])
    const group = screen.getByRole('region', { name: '连发' })
    expect(within(group).getByText('连发1')).toBeTruthy()
    expect(within(group).getByText('连发 Z（间隔 50）')).toBeTruthy()
    expect(within(group).getByText('当前键')).toBeTruthy()
  })

  it('cannot store plain keys', () => {
    render(<Harness initial={factoryDraft()} selectedAction={{ type: 'key', code: 'KeyA' }} />)
    const add = screen.getByRole('button', { name: /存入动作库/ }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect(add.title).toMatch(/只有组合键、宏和连发/)
  })

  it('lists groups with summaries and usage, and selects a using key', () => {
    const onSelectKey = vi.fn()
    render(<Harness initial={libDraft()} onSelectKey={onSelectKey} />)
    const combos = screen.getByRole('region', { name: '组合键' })
    expect(within(combos).getByText('组合键1')).toBeTruthy()
    expect(within(combos).getByText('左 Ctrl + C')).toBeTruthy()
    expect(within(combos).getByText('用于 2 个键')).toBeTruthy()
    fireEvent.click(within(combos).getByRole('button', { name: 'Fn 层 · F2' }))
    expect(onSelectKey).toHaveBeenCalledWith('fn', 'f2')
    const macros = screen.getByRole('region', { name: '宏' })
    expect(within(macros).getByText('宏：H → I（播放 1 遍）')).toBeTruthy()
    expect(within(macros).getByText('还没有键使用')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: '连发' })).getByText('还没有连发')).toBeTruthy()
  })

  it('applies a copy of the entry to the current key only when a key is selected', () => {
    const onApply = vi.fn()
    const { rerender } = render(<LibraryPanel draft={libDraft()} onChange={() => {}} onApply={onApply} />)
    const apply = () => screen.getByRole('button', { name: '把“组合键1”用到当前键' }) as HTMLButtonElement
    expect(apply().disabled).toBe(true)
    rerender(<LibraryPanel draft={libDraft()} onChange={() => {}} onApply={onApply} selectedAction={{ type: 'none' }} />)
    fireEvent.click(apply())
    expect(onApply).toHaveBeenCalledWith(copy, expect.objectContaining({ name: '组合键1' }))
  })

  it('renames inline with validation, Enter to commit and Escape to cancel', () => {
    const log = vi.fn()
    render(<Harness initial={addToLibrary(libDraft(), { type: 'combo', keys: ['ControlLeft', 'KeyV'] }).draft} log={log} />)
    fireEvent.click(screen.getByRole('button', { name: '重命名“组合键1”' }))
    const input = screen.getByRole('textbox', { name: '“组合键1”的新名称' })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: '组合键2' } })
    expect(screen.getByRole('alert').textContent).toMatch(/已经有一个叫“组合键2”/)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(log).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重命名“组合键1”' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '复制' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(log).toHaveBeenCalledWith('动作库：重命名“组合键1”为“复制”', expect.anything())
    expect(screen.getByText('复制')).toBeTruthy()
  })

  it('duplicates and deletes entries', () => {
    const log = vi.fn()
    render(<Harness initial={libDraft()} log={log} />)
    fireEvent.click(screen.getByRole('button', { name: '复制“组合键1”' }))
    expect(log).toHaveBeenLastCalledWith('动作库：复制“组合键1”', expect.anything())
    expect(screen.getByText('组合键1 副本')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除“宏1”' }))
    expect(log).toHaveBeenLastCalledWith('动作库：删除“宏1”', expect.anything())
    expect(within(screen.getByRole('region', { name: '宏' })).getByText('还没有宏')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除“组合键1”' }))
    fireEvent.click(screen.getByRole('button', { name: '删除“组合键1 副本”' }))
    expect(screen.getByText(/相当于 KB84 的预定义列表/)).toBeTruthy()
  })
})

describe('LibraryPanel guards (review regressions)', () => {
  it('does not store an invalid action (it would block every write with a library error)', () => {
    const log = vi.fn()
    // A one-key combo does not compile.
    render(<Harness initial={factoryDraft()} selectedAction={{ type: 'combo', keys: ['KeyA'] }} selectedLabel="基础层 · A" log={log} />)
    const add = screen.getByRole('button', { name: /存入动作库/ }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect(add.title).toMatch(/错误/)
    fireEvent.click(add)
    expect(log).not.toHaveBeenCalled()
  })

  it('still stores a valid action and labels the undo step', () => {
    const log = vi.fn()
    render(<Harness initial={factoryDraft()} selectedAction={emu} selectedLabel="基础层 · A" log={log} />)
    fireEvent.click(screen.getByRole('button', { name: /存入动作库/ }))
    expect(log).toHaveBeenCalledWith('动作库：新建“连发1”', expect.anything())
  })
})
