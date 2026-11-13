// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceUi } from '../state/useDevice'
import { ConnectionBar } from './ConnectionBar'

afterEach(cleanup)

const BASE: DeviceUi = {
  connected: false,
  kind: null,
  name: '',
  version: undefined,
  simMode: null,
  busy: null,
  support: 'ok',
  auto: false,
  autoConnect: true,
  autoPaused: false,
  granted: true,
  failure: null,
}

const REAL: Partial<DeviceUi> = { connected: true, kind: 'webhid', name: '84EC-S' }

function bar(device: Partial<DeviceUi>, handlers: Partial<Parameters<typeof ConnectionBar>[0]> = {}) {
  const props = {
    onConnect: vi.fn(),
    onSimulator: vi.fn(),
    onDisconnect: vi.fn(),
    onVersion: vi.fn(),
    onSimMode: vi.fn(),
    onRetry: vi.fn(),
    onAutoConnect: vi.fn(),
    onDismissFailure: vi.fn(),
    ...handlers,
  }
  const view = render(<ConnectionBar device={{ ...BASE, ...device }} {...props} />)
  const rerender = (next: Partial<DeviceUi>) => view.rerender(<ConnectionBar device={{ ...BASE, ...next }} {...props} />)
  return { ...props, rerender }
}

const openConn = () => {
  fireEvent.click(screen.getByRole('button', { name: /^已连接/ }))
  return screen.getByRole('dialog', { name: '连接' })
}

describe('ConnectionBar, not connected', () => {
  it('makes 连接键盘 the one primary action and offers the simulator as a link', () => {
    bar({})
    const connect = screen.getByRole('button', { name: /连接键盘/ })
    expect(connect.className).toContain('btn-primary')
    expect(screen.getByRole('button', { name: '使用模拟键盘' }).className).toContain('link-btn')
    expect(screen.getByText('没有键盘？')).toBeTruthy()
    expect(screen.getByText('未连接')).toBeTruthy()
  })

  it('tells a first visit to choose the keyboard and hides the 自动连接 switch until one is granted', () => {
    bar({ granted: false })
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('第一次使用请点“连接键盘”，在弹窗里选 84EC-S')
    expect(status.textContent).not.toContain('自动连接')
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('has a labelled 自动连接 switch that reports changes once a keyboard is granted', () => {
    const p = bar({})
    const sw = screen.getByRole('switch', { name: '自动连接' }) as HTMLInputElement
    expect(sw.checked).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('插上键盘会自动连接')
    fireEvent.click(sw)
    expect(p.onAutoConnect).toHaveBeenCalledWith(false)
    cleanup()

    bar({ autoPaused: true })
    expect(screen.getByRole('status').textContent).toContain('自动连接已暂停')
    expect(screen.getByRole('status').textContent).not.toContain('插上键盘')
    expect(screen.getByRole('switch', { name: '自动连接' }).getAttribute('aria-describedby')).toBeTruthy()
    cleanup()

    bar({ autoConnect: false })
    expect(screen.getByRole('status').textContent).toBe('未连接')
  })

  it('offers 重试 for a busy keyboard, keeps the browser’s words under 详情 and can dismiss the message', () => {
    const p = bar({
      failure: { kind: 'busy', message: '键盘被占用：请关闭 KB84 软件。', auto: true, canRetry: true, detail: 'Failed to open the device.' },
    })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('自动连接失败。键盘被占用')
    const details = alert.querySelector('details')!
    expect(within(details).getByText('详情').tagName).toBe('SUMMARY')
    expect(details.textContent).toContain('Failed to open the device.')
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(p.onRetry).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }))
    expect(p.onDismissFailure).toHaveBeenCalledTimes(1)
    cleanup()

    // Without an onRetry handler, 重试 falls back to 连接键盘; without a detail there is no 详情.
    const q = bar({ failure: { kind: 'busy', message: 'x', auto: false, canRetry: true } }, { onRetry: undefined })
    expect(screen.getByRole('alert').querySelector('details')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /重试/ }))
    expect(q.onConnect).toHaveBeenCalledTimes(1)
  })

  it('explains an insecure page and an unsupported browser and hides the switch', () => {
    bar({ support: 'insecure' })
    expect(screen.getByRole('note').textContent).toMatch(/https:\/\//)
    expect(screen.getByRole('note').textContent).toMatch(/localhost/)
    expect(screen.queryByRole('switch')).toBeNull()
    expect((screen.getByRole('button', { name: /连接键盘/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('未连接')
    cleanup()

    bar({ support: 'unsupported' })
    expect(screen.getByRole('note').textContent).toMatch(/不支持 WebHID/)
    expect(screen.getByRole('button', { name: /使用模拟键盘/ })).toBeTruthy()
  })

  it('keeps working without the new handlers', () => {
    bar({}, { onAutoConnect: undefined, onRetry: undefined, onDismissFailure: undefined })
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.getByText('未连接')).toBeTruthy()
  })
})

describe('ConnectionBar, connected', () => {
  it('shows the connection in a pill that opens the 连接 popover with firmware, 自动连接 and 断开', () => {
    const p = bar({ ...REAL, auto: true })
    expect(screen.getByRole('status').textContent).toContain('已连接键盘 84EC-S')
    const pill = screen.getByRole('button', { name: /^已连接/ })
    expect(pill.textContent).toMatch(/已连接\s*84EC-S · 已自动连接/)
    expect(pill.textContent).not.toContain('模拟键盘') // no badge for a real keyboard
    // Secondary controls are not on the bar itself.
    expect(screen.queryByRole('button', { name: '查询固件版本' })).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('button', { name: /断开/ })).toBeNull()

    const pop = openConn()
    const query = within(pop).getByRole('button', { name: '查询固件版本' })
    expect(query.textContent).toBe('查询')
    expect(query.getAttribute('title')).toBe('向键盘查询固件版本，只读，不会改动键盘')
    fireEvent.click(query)
    expect(p.onVersion).toHaveBeenCalledTimes(1)
    const sw = within(pop).getByRole('switch', { name: '自动连接' })
    expect(within(pop).getByText('打开本页或插上键盘时自动连接').id).toBe(sw.getAttribute('aria-describedby'))
    const disconnect = within(pop).getByRole('button', { name: /断开/ })
    expect(document.getElementById(disconnect.getAttribute('aria-describedby')!)!.textContent).toBe(
      '断开后，本页暂停自动连接，直到再次点“连接键盘”。',
    )
    fireEvent.click(disconnect)
    expect(p.onDisconnect).toHaveBeenCalledTimes(1)
  })

  it('shows the firmware version once known', () => {
    bar({ ...REAL, version: 'SIM-84EC-S;1.0' })
    expect(within(openConn()).getByText('固件版本：SIM-84EC-S · 1.0')).toBeTruthy()
    cleanup()
    bar({ ...REAL, version: null })
    expect(openConn().textContent).toContain('固件版本：未知（键盘没有回应）')
  })

  it('opens popovers without a modal: focus moves in, Esc gives it back, a click outside closes', () => {
    bar(REAL)
    const pill = screen.getByRole('button', { name: /^已连接/ })
    expect(pill.getAttribute('aria-expanded')).toBe('false')
    pill.focus()
    const pop = openConn()
    expect(pill.getAttribute('aria-expanded')).toBe('true')
    expect(pill.getAttribute('aria-controls')).toBe(pop.id)
    expect(document.activeElement).toBe(within(pop).getByRole('button', { name: '查询固件版本' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(pill)
    expect(pill.getAttribute('aria-expanded')).toBe('false')

    openConn()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()

    // The mode popover has no controls for an unknown mode: the popover itself takes focus.
    const chip = screen.getByRole('button', { name: /M 灯/ })
    fireEvent.click(chip)
    const help = screen.getByRole('dialog', { name: '编程模式和办公模式' })
    expect(chip.getAttribute('aria-controls')).toBe(help.id)
    expect(document.activeElement).toBe(help)
    // Opening one popover closes the other (its trigger is outside).
    fireEvent.mouseDown(screen.getByRole('button', { name: /^已连接/ }))
    fireEvent.click(screen.getByRole('button', { name: /^已连接/ }))
    expect(screen.getAllByRole('dialog').map((d) => d.getAttribute('aria-label'))).toEqual(['连接'])
  })

  it('keeps focus in the popover when 查询 turns into the version, and sends it to 连接键盘 after 断开', () => {
    const p = bar(REAL)
    const pop = openConn()
    expect(document.activeElement?.textContent).toBe('查询')
    p.rerender({ ...REAL, version: 'SIM-84EC-S 1.0' })
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '连接' }))
    expect(pop.isConnected).toBe(true)

    within(pop).getByRole('button', { name: /断开/ }).focus()
    fireEvent.click(within(pop).getByRole('button', { name: /断开/ }))
    p.rerender({ autoPaused: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /连接键盘/ }))
  })

  it('keeps the simulator’s M switch, with the explanation beside it', () => {
    const p = bar({ connected: true, kind: 'simulator', name: '84EC-S', simMode: 'program' })
    expect(screen.getByRole('button', { name: /^已连接/ }).textContent).toMatch(/已连接\s*模拟键盘\s*84EC-S/)
    expect(screen.getByRole('status').textContent).toContain('已连接模拟键盘 84EC-S')
    const sw = screen.getByRole('button', { name: /编程模式/ })
    expect(sw.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(sw)
    expect(p.onSimMode).toHaveBeenCalledWith('office')
    fireEvent.click(screen.getByRole('button', { name: '两种模式的说明' }))
    expect(screen.getByRole('dialog', { name: '编程模式和办公模式' }).textContent).toContain('键盘里存着两套键位')
  })
})

describe('ModeChip on a real keyboard', () => {
  const chipText = () => screen.getByRole('button', { name: /M 灯/ }).textContent

  it('shows the mode App inferred', () => {
    const cases = [
      [undefined, 'M 灯 · 读取前请确认亮着', ''],
      ['unknown', 'M 灯 · 读取前请确认亮着', ''],
      ['program', '编程模式 · M 灯亮', 'is-on'],
      ['maybe-office', '读到出厂键位 · M 灯亮着吗？', 'is-warn'],
      ['office', '办公模式 · M 灯灭', 'is-warn'],
    ] as const
    for (const [modeHint, text, tone] of cases) {
      bar(REAL, { modeHint })
      expect(chipText()).toBe(`M${text}`)
      const cls = screen.getByRole('button', { name: /M 灯/ }).className
      if (tone) expect(cls).toContain(tone)
      else expect(cls).toBe('mlight')
      cleanup()
    }
  })

  it('explains both modes; maybe-office offers [M 灯亮着] and [重新读取]', () => {
    const p = bar(REAL, { modeHint: 'maybe-office', onConfirmProgram: vi.fn(), onReread: vi.fn() })
    const chip = screen.getByRole('button', { name: /M 灯/ })
    fireEvent.click(chip)
    const help = screen.getByRole('dialog', { name: '编程模式和办公模式' })
    expect(help.textContent).toContain('编程模式（F12 上的 M 灯亮）：用你写入的键位')
    expect(help.textContent).toContain('办公模式（M 灯灭）：用出厂键位')
    expect(help.textContent).toContain('切换：按住 Fn+F12 约 2 秒。')
    expect(help.textContent).toContain('灯不亮的话，先按住 Fn+F12 约 2 秒，灯亮后点“重新读取”。')
    expect(document.activeElement).toBe(within(help).getByRole('button', { name: 'M 灯亮着' }))
    fireEvent.click(within(help).getByRole('button', { name: 'M 灯亮着' }))
    expect(p.onConfirmProgram).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(chip)

    fireEvent.click(chip)
    fireEvent.click(screen.getByRole('button', { name: /重新读取/ }))
    expect(p.onReread).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('only explains in Program mode, and disables device actions while busy', () => {
    bar(REAL, { modeHint: 'program', onConfirmProgram: vi.fn(), onReread: vi.fn() })
    fireEvent.click(screen.getByRole('button', { name: /M 灯/ }))
    expect(within(screen.getByRole('dialog')).queryAllByRole('button')).toEqual([])
    cleanup()

    bar({ ...REAL, busy: { op: 'read', done: 0, total: 0 } }, { modeHint: 'office', onReread: vi.fn() })
    fireEvent.click(screen.getByRole('button', { name: /M 灯/ }))
    expect(screen.getByRole('dialog').textContent).toContain('M 灯亮后点“重新读取”，才能读到键盘里的键位。')
    expect((screen.getByRole('button', { name: /重新读取/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a write made in Office mode stays pending, with [M 灯已亮，重新校验]', () => {
    const p = bar(REAL, { modeHint: 'office', pendingVerify: true, onReverify: vi.fn(), onReread: vi.fn() })
    expect(chipText()).toBe('M已写入，未生效 · M 灯灭')
    fireEvent.click(screen.getByRole('button', { name: /M 灯/ }))
    const help = screen.getByRole('dialog')
    expect(within(help).queryByRole('button', { name: /重新读取/ })).toBeNull()
    fireEvent.click(within(help).getByRole('button', { name: 'M 灯已亮，重新校验' }))
    expect(p.onReverify).toHaveBeenCalledTimes(1)
    cleanup()

    // pendingVerify only matters in Office mode.
    bar(REAL, { modeHint: 'program', pendingVerify: true, onReverify: vi.fn() })
    expect(chipText()).toBe('M编程模式 · M 灯亮')
  })
})
