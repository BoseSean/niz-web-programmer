// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Action, MacroStep } from '../../../format/types'
import { MacroEditor } from './MacroEditor'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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

const empty: Macro = { type: 'macro', play: 'repeat', repeat: 1, interval: 30, steps: [] }

/** A keyboard press on whatever has focus (the recorder listens on the window, in the capture phase). */
const press = (code: string, key = code) => {
  const target = document.activeElement ?? document.body
  const down = fireEvent.keyDown(target, { code, key })
  fireEvent.keyUp(target, { code, key })
  return down
}

/** Starts recording from the keyboard: focus 录制 and press Enter (a click, as a browser does for Enter on a button). */
function startRecording() {
  const button = screen.getByRole('button', { name: '录制' })
  button.focus()
  fireEvent.click(button)
  return button
}

const stepsOf = (log: ReturnType<typeof vi.fn>) => (log.mock.lastCall?.[0] as Macro | undefined)?.steps

describe('MacroEditor recording', () => {
  it('says on the button and in the live text how to stop it from the keyboard', () => {
    render(<Harness initial={empty} />)
    const button = startRecording()
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.textContent).toBe('停止录制（或连按两次 Esc）')
    expect(screen.getByRole('status').textContent).toMatch(/录完后点“停止录制”或连按两次 Esc.*这两次 Esc 不会录进去/)
  })

  it('records Tab, Enter, Space and a single Esc like any other key', () => {
    const log = vi.fn()
    render(<Harness initial={empty} log={log} />)
    const button = startRecording()
    for (const code of ['Tab', 'Enter', 'Space', 'Escape']) expect(press(code)).toBe(false) // swallowed, recorded
    expect(document.activeElement).toBe(button)
    expect(log).not.toHaveBeenCalled() // still recording
    fireEvent.click(button)
    expect(stepsOf(log)).toEqual<MacroStep[]>([{ tap: 'Tab' }, { tap: 'Enter' }, { tap: 'Space' }, { tap: 'Escape' }])
  })

  it('stops on two Esc presses in a row and records neither of them', () => {
    const log = vi.fn()
    render(<Harness initial={empty} log={log} />)
    const button = startRecording()
    press('KeyA', 'a')
    press('Escape')
    press('Escape')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(document.activeElement).toBe(button)
    expect(stepsOf(log)).toEqual<MacroStep[]>([{ tap: 'KeyA' }])
    // recording is over: keys reach the page again
    expect(press('Tab')).toBe(true)
  })

  it('keeps the existing steps when the two Esc presses are all that was pressed', () => {
    const log = vi.fn()
    render(<Harness initial={{ ...empty, steps: [{ tap: 'KeyB' }] }} log={log} />)
    const button = screen.getByRole('button', { name: /重新录制（替换 1 步）/ })
    button.focus()
    fireEvent.click(button)
    press('Escape')
    press('Escape')
    expect(log).not.toHaveBeenCalled()
    expect(button.textContent).toBe('重新录制（替换 1 步）')
  })

  it('records both presses when the second Esc comes late, follows another key, or has a modifier', () => {
    const log = vi.fn()
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
    render(<Harness initial={empty} log={log} />)
    const button = startRecording()
    press('Escape')
    now.mockReturnValue(2000) // 1 s later
    press('Escape')
    press('KeyA', 'a')
    press('Escape')
    fireEvent.keyDown(document.activeElement!, { code: 'Escape', key: 'Escape', shiftKey: true })
    fireEvent.keyUp(document.activeElement!, { code: 'Escape', key: 'Escape', shiftKey: true })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)
    expect(stepsOf(log)).toEqual<MacroStep[]>([
      { tap: 'Escape' },
      { tap: 'Escape' },
      { tap: 'KeyA' },
      { tap: 'Escape' },
      { tap: 'Escape' },
    ])
  })
})

describe('MacroEditor settings from the keyboard', () => {
  const macro: Macro = { ...empty, repeat: 3, steps: [{ tap: 'KeyA' }, { wait: 50 }, { tap: 'KeyB' }], interval: undefined }

  it('arrows through 播放方式 and 按键之间 without converting the macro; Space (a click) selects', () => {
    const log = vi.fn()
    render(<Harness initial={macro} log={log} />)
    const play = screen.getByRole('radio', { name: '按一下播放' })
    play.focus()
    fireEvent.keyDown(play, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /按住时播放/ }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(play)

    const timing = screen.getByRole('radiogroup', { name: '按键之间' })
    const steps = screen.getByRole('radio', { name: '逐步设置' })
    expect(steps.tabIndex).toBe(0)
    steps.focus()
    fireEvent.keyDown(steps, { key: 'ArrowLeft' })
    expect(document.activeElement?.textContent).toBe('统一间隔')
    expect(timing.contains(document.activeElement)).toBe(true)
    // the repeat count and the wait are still there, and no confirm to drop the waits was asked
    expect(log).not.toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: '改为统一间隔' })).toBeNull()

    fireEvent.click(document.activeElement!)
    expect(screen.getByRole('group', { name: '改为统一间隔' })).toBeTruthy()
  })
})
