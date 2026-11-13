// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Action, MacroStep } from '../../../format/types'
import { MacroEditor } from './MacroEditor'

afterEach(cleanup)

type Macro = Extract<Action, { type: 'macro' }>

/** Keeps the macro in state like the inspector does; `log` sees every change. */
function Harness({ initial, log }: { initial: Macro; log?: (a: Action) => void }) {
  const [action, setAction] = useState(initial)
  return (
    <MacroEditor
      action={action}
      stepIssues={new Map()}
      onChange={(a) => {
        log?.(a)
        setAction(a as Macro)
      }}
    />
  )
}

const copyPaste: Macro = {
  type: 'macro',
  play: 'repeat',
  repeat: 1,
  interval: 30,
  steps: [{ down: 'ControlLeft' }, { tap: 'KeyC' }, { up: 'ControlLeft' }, { tap: 'KeyV' }],
}
const timing = () => screen.getByRole('radiogroup', { name: '按键之间' })
const steps = () => within(document.querySelector('ol.steps') as HTMLElement).queryAllByRole('listitem')

describe('MacroEditor', () => {
  it('shows the steps and what they type before the playback settings', () => {
    render(<Harness initial={copyPaste} />)
    expect(screen.getByText('效果：Ctrl+C → V · 播放一遍约 0.2 秒')).toBeTruthy()
    const list = document.querySelector('ol.steps')!
    const play = screen.getByRole('group', { name: '播放设置' })
    expect(list.compareDocumentPosition(play) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: /重新录制（替换 4 步）/ })).toBeTruthy()
    expect(screen.getByText('每个按下/松开之间都等 30 ms')).toBeTruthy()
    // capacity: one plain line, the protocol numbers in the tooltip
    const meter = screen.getByRole('group', { name: '宏的容量' })
    expect(within(meter).getByText('容量 已用 1%')).toBeTruthy()
    expect(meter.title).toBe('6 / 1600 字节 · 6 个按键事件 · 1 个数据包')
  })

  it('offers plain recording for an empty macro', () => {
    render(<Harness initial={{ ...copyPaste, steps: [] }} />)
    expect(screen.getByRole('button', { name: '录制' })).toBeTruthy()
    expect(screen.queryByText(/^效果：/)).toBeNull()
  })

  it('puts the repeat count in the sentence and marks the untested play modes', () => {
    const log = vi.fn()
    render(<Harness initial={copyPaste} log={log} />)
    expect(screen.getByLabelText('播放遍数')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('播放遍数'), { target: { value: '3' } })
    expect(log).toHaveBeenLastCalledWith(expect.objectContaining({ repeat: 3 }))
    fireEvent.click(screen.getByRole('radio', { name: /按住时播放/ }))
    expect(screen.getByRole('radio', { name: /按住时播放/ }).textContent).toContain('实验性')
    expect(screen.getByText('按住时播放，松开就停止。写入后请实际试一试。')).toBeTruthy()
    expect(screen.queryByLabelText('播放遍数')).toBeNull()
  })

  it('switches 统一间隔 → 逐步设置 without changing the playback', () => {
    const log = vi.fn()
    render(<Harness initial={copyPaste} log={log} />)
    fireEvent.click(within(timing()).getByRole('radio', { name: '逐步设置' }))
    const next = log.mock.lastCall![0] as Macro
    expect(next.interval).toBeUndefined()
    expect(next.steps.filter((s) => 'wait' in s)).toHaveLength(5)
    expect(next.steps.every((s) => !('wait' in s) || s.wait === 30)).toBe(true)
    expect(screen.getByRole('status').textContent).toMatch(/统一间隔 30 ms 写成了“等待”步骤，播放效果不变/)
    expect(screen.getByText('效果：Ctrl+C → 停 30 ms → V · 播放一遍约 0.2 秒')).toBeTruthy()
  })

  it('asks before 逐步设置 → 统一间隔 drops the waits; 取消 leaves the steps untouched', () => {
    const log = vi.fn()
    const recorded: Macro = { type: 'macro', play: 'repeat', repeat: 1, steps: [{ down: 'KeyA' }, { wait: 80 }, { up: 'KeyA' }, { wait: 120 }, { tap: 'KeyB' }] }
    render(<Harness initial={recorded} log={log} />)
    fireEvent.click(within(timing()).getByRole('radio', { name: '统一间隔' }))
    const confirm = screen.getByRole('group', { name: '改为统一间隔' })
    expect(confirm.textContent).toContain('将删除 2 个“等待”步骤，改为统一间隔')
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: '确定' }))
    expect(log).not.toHaveBeenCalled()

    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('group', { name: '改为统一间隔' })).toBeNull()
    expect(log).not.toHaveBeenCalled()
    expect(steps()).toHaveLength(5)
    expect(within(timing()).getByRole('radio', { name: '逐步设置' }).getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(within(timing()).getByRole('radio', { name: '逐步设置' }))

    fireEvent.click(within(timing()).getByRole('radio', { name: '统一间隔' }))
    const again = screen.getByRole('group', { name: '改为统一间隔' })
    fireEvent.change(within(again).getByLabelText('统一间隔（毫秒）'), { target: { value: '50' } })
    fireEvent.click(within(again).getByRole('button', { name: '确定' }))
    expect(log).toHaveBeenLastCalledWith({ type: 'macro', play: 'repeat', repeat: 1, interval: 50, steps: [{ tap: 'KeyA' }, { tap: 'KeyB' }] })
    expect(document.activeElement).toBe(within(timing()).getByRole('radio', { name: '统一间隔' }))
  })

  it('switches 逐步设置 → 统一间隔 directly when there are no waits', () => {
    const log = vi.fn()
    render(<Harness initial={{ type: 'macro', play: 'repeat', repeat: 1, steps: [{ tap: 'KeyA' }] }} log={log} />)
    fireEvent.click(within(timing()).getByRole('radio', { name: '统一间隔' }))
    expect(screen.queryByRole('group', { name: '改为统一间隔' })).toBeNull()
    expect(log).toHaveBeenLastCalledWith(expect.objectContaining({ interval: 30, steps: [{ tap: 'KeyA' }] }))
  })

  it('+ 等待 with a fixed interval switches to 逐步设置 first', () => {
    const log = vi.fn()
    render(<Harness initial={{ ...copyPaste, steps: [{ tap: 'KeyA' }] }} log={log} />)
    fireEvent.click(screen.getByRole('button', { name: '等待' }))
    expect(log).toHaveBeenLastCalledWith({ type: 'macro', play: 'repeat', repeat: 1, steps: [{ down: 'KeyA' }, { wait: 30 }, { up: 'KeyA' }, { wait: 100 }] })
    expect(within(timing()).getByRole('radio', { name: '逐步设置' }).getAttribute('aria-checked')).toBe('true')
  })

  it('refuses 逐步设置 for a macro that would not fit, and says why', () => {
    const log = vi.fn()
    const long: MacroStep[] = Array.from({ length: 201 }, (_, i) => ({ tap: i % 2 ? 'KeyA' : 'KeyB' }))
    render(<Harness initial={{ ...copyPaste, steps: long }} log={log} />)
    fireEvent.click(within(timing()).getByRole('radio', { name: '逐步设置' }))
    expect(log).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('这个宏太长，改成逐步设置会超出容量（最多约 400 个按键事件）')
    expect(within(timing()).getByRole('radio', { name: '统一间隔' }).getAttribute('aria-checked')).toBe('true')
    // fixed-interval macros of this size are beyond what was tested on the keyboard
    expect(screen.getByText('这个宏比真机上测试过的最长宏更长，写入后请实际试一试。')).toBeTruthy()
  })
})
