// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangeRow } from '../lib/changes'
import { WriteDialog, type WriteOutcome, type WriteStage } from './WriteDialog'
import { formatSavedAt } from '../lib/describe'

afterEach(cleanup)

type Props = ComponentProps<typeof WriteDialog>

const CAPS: ChangeRow = { layer: 'base', keyId: 'caps', where: '基础层 · Caps Lock', from: 'Caps Lock', to: 'Esc' }
const F1: ChangeRow = { layer: 'fn', keyId: 'f1', where: 'Fn 层 · F1', from: 'F1', to: '静音' }
const A: ChangeRow = { layer: 'base', keyId: 'a', where: '基础层 · A', from: 'A', to: 'B' }
const Q: ChangeRow = { layer: 'base', keyId: 'q', where: '基础层 · Q', from: 'Q', to: 'W' }

function dialog(stage: WriteStage, props: Partial<Props> = {}) {
  const p: Props = {
    stage,
    changes: [CAPS],
    baseline: 'device',
    warnings: [],
    cautions: [],
    busy: null,
    onBackup: vi.fn(),
    onConfirm: vi.fn(),
    onReverify: vi.fn(),
    onClose: vi.fn(),
    ...props,
  }
  const view = render(<WriteDialog {...p} />)
  return { p, view, rerender: (more: Partial<Props>) => view.rerender(<WriteDialog {...p} {...more} />) }
}

const result = (outcome: WriteOutcome, props: Partial<Props> = {}) => dialog({ stage: 'result', outcome }, props)

describe('WriteDialog: confirm', () => {
  it('lists what changes on the keyboard, the checklist and the 生效条件, and confirms', () => {
    const { p } = dialog({ stage: 'confirm' })
    const dlg = screen.getByRole('dialog', { name: '写入键盘' })
    // WriteDialog.css scopes its overrides of app.css (the footer wrapping on a phone) under this class.
    expect(dlg.classList).toContain('write-dialog')
    expect(within(dlg).getByText('将把页面上的键位写入键盘，有 1 个键位会改变：')).toBeTruthy()
    expect(within(dlg).getByRole('columnheader', { name: '键盘里现在' })).toBeTruthy()
    expect(within(dlg).getByRole('columnheader', { name: '写入后' })).toBeTruthy()
    expect(within(dlg).getByText('基础层 · Caps Lock')).toBeTruthy()
    expect(within(dlg).getByText(/写入前自动备份键盘里现在的键位/)).toBeTruthy()
    expect(within(dlg).getByText('写完自动读回校验')).toBeTruthy()
    expect(within(dlg).getByText('生效条件：F12 上的 M 灯亮（编程模式）').closest('li')!.className).toContain('write-cond')
    expect(within(dlg).queryByRole('button', { name: /先导出备份/ })).toBeNull()
    expect(within(dlg).queryByRole('button', { name: /先重新读取键盘/ })).toBeNull()

    fireEvent.click(within(dlg).getByRole('button', { name: '另存为文件' }))
    expect(p.onBackup).toHaveBeenCalledTimes(1)
    const confirm = within(dlg).getByRole('button', { name: '确认写入' })
    expect(confirm.className).toContain('btn-primary')
    fireEvent.click(confirm)
    expect(p.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('says so when nothing changes, and compares with the factory map when the keyboard could not be read', () => {
    dialog({ stage: 'confirm' }, { changes: [] })
    expect(screen.getByText('页面上的键位与键盘里的一致；仍会重新写入全部键位。')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    cleanup()

    dialog({ stage: 'confirm' }, { baseline: 'factory', preReadFailed: true, changes: [CAPS, A] })
    expect(screen.getByText('没能读取键盘，下面是与出厂键位的比较；写入会覆盖键盘里的全部键位。有 2 处不同：')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '出厂' })).toBeTruthy()
    expect(screen.getByText('写入前会再读取一次键盘并备份；读不到就这次不备份')).toBeTruthy()
    // The file export would hold the page, not the keyboard: not offered next to the backup line.
    expect(screen.queryByRole('button', { name: '另存为文件' })).toBeNull()
    cleanup()

    dialog({ stage: 'confirm' }, { baseline: 'factory', changes: [CAPS] })
    expect(screen.getByText(/^还没有读取键盘，下面是与出厂键位的比较/)).toBeTruthy()
  })

  it('warns about the M light first: 仍然写入 is the primary button and 先重新读取键盘 re-reads', () => {
    const onReread = vi.fn()
    const { p } = dialog({ stage: 'confirm' }, { modeWarning: true, onReread })
    const dlg = screen.getByRole('dialog', { name: '写入键盘' })
    const warn = dlg.querySelector('.write-mode-warn')!
    expect(warn.className).toContain('note-warn')
    expect(warn.textContent).toBe(
      '上次读到的是出厂键位，还不确定当时 M 灯是否亮着。如果键盘里原本有你改过的键位，这次写入会把它们覆盖，自动备份里也只有出厂键位。',
    )
    // The warning comes before what the write changes.
    expect(warn.compareDocumentPosition(within(dlg).getByText(/有 1 个键位会改变/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(dlg).queryByRole('button', { name: '确认写入' })).toBeNull()
    const go = within(dlg).getByRole('button', { name: '仍然写入' })
    expect(go.className).toContain('btn-primary')

    const reread = within(dlg).getByRole('button', { name: '先重新读取键盘' })
    expect(reread.title).toBe('重新读取键盘里的键位（页面上的修改保留）')
    expect(reread.className).not.toContain('btn-primary')
    fireEvent.click(reread)
    expect(onReread).toHaveBeenCalledTimes(1)
    fireEvent.click(go)
    expect(p.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('words the M-light warning for a write of the factory map', () => {
    dialog({ stage: 'confirm' }, { modeWarning: 'uncertain', writtenIsFactory: true, onReread: vi.fn() })
    expect(document.querySelector('.write-mode-warn')!.textContent).toBe(
      '上次读到的是出厂键位，还不确定当时 M 灯是否亮着。如果键盘里原本有你改过的键位，这次写入会把它们改成出厂键位，自动备份里也只有出厂键位。',
    )
  })

  it('in Office mode with the keys known, says the M light is off and that the backup holds the changed keys', () => {
    const onReread = vi.fn()
    const { p } = dialog({ stage: 'confirm' }, { modeWarning: 'office', writtenIsFactory: true, onReread })
    const dlg = screen.getByRole('dialog', { name: '写入键盘' })
    const warn = dlg.querySelector('.write-mode-warn')!
    expect(warn.textContent).toBe(
      '键盘现在多半是办公模式（M 灯灭）：刚才读到的是出厂键位，但键盘里存着你改过的键位。写入会覆盖它们。请先按住 Fn+F12 约 2 秒让 M 灯亮起，再点“先重新读取键盘”。自动备份会保存你上次读到或写入的键位。',
    )
    expect(dlg.textContent).not.toMatch(/还不确定|自动备份里也只有出厂键位/)
    fireEvent.click(within(dlg).getByRole('button', { name: '先重新读取键盘' }))
    expect(onReread).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dlg).getByRole('button', { name: '仍然写入' }))
    expect(p.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('says when 先重新读取键盘 failed, first and without a doubled 。', () => {
    dialog({ stage: 'confirm' }, { modeWarning: 'office', onReread: vi.fn(), rereadError: '键盘没有回应。' })
    const note = screen.getByText('重新读取失败：键盘没有回应。').closest('.note')!
    expect(note.className).toContain('note-warn')
    expect(note.compareDocumentPosition(document.querySelector('.write-mode-warn')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The confirmation that comes back is not the same as before: focus (and a screen reader) starts at the failure.
    expect(document.activeElement).toBe(note)
    cleanup()

    dialog({ stage: 'confirm' }, { rereadError: 'Device lost' })
    expect(screen.getByText('重新读取失败：Device lost。')).toBeTruthy()
    cleanup()

    dialog({ stage: 'confirm' }, { rereadError: null })
    expect(screen.queryByText(/重新读取失败/)).toBeNull()
  })

  it('puts the cautions in the red 写入后可能回不来 box, ending with the 键盘复位 combination', () => {
    dialog({ stage: 'confirm' }, { cautions: ['Fn 层的 F12 不再是“办公/编程模式切换”。'] })
    const box = screen.getByRole('group', { name: '写入后可能回不来' })
    expect(box.className).toContain('write-danger')
    const items = within(box).getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([
      'Fn 层的 F12 不再是“办公/编程模式切换”。',
      '万一回不来：同时按住 Esc + Delete + 左 Ctrl + → 约 5 秒，键盘复位。',
    ])
    cleanup()

    dialog({ stage: 'confirm' })
    expect(screen.queryByRole('group', { name: '写入后可能回不来' })).toBeNull()
  })

  it('folds the format warnings away: they do not stop the write', () => {
    dialog({ stage: 'confirm' }, { warnings: [{ severity: 'warning', path: '/layers/base/caps', message: 'x' }] })
    const hints = document.querySelector('details.write-hints') as HTMLDetailsElement
    expect(hints.open).toBe(false)
    expect(within(hints).getByText('1 条提示（不影响写入）').tagName).toBe('SUMMARY')
    expect(hints.querySelectorAll('li.issue')).toHaveLength(1)
  })
})

describe('WriteDialog: progress', () => {
  it('shows the read before the confirmation with a 取消 that is not locked', () => {
    const onCancelPrepare = vi.fn()
    const { p } = dialog({ stage: 'preparing' }, { busy: { op: 'read', done: 42, total: 168 }, onCancelPrepare })
    const dlg = screen.getByRole('dialog', { name: '写入键盘' })
    expect(within(dlg).getByText('正在读取键盘里现在的键位，用来对比和备份…')).toBeTruthy()
    const bar = within(dlg).getByRole('progressbar', { name: '正在读取键盘里现在的键位，用来对比和备份…' })
    expect(bar.getAttribute('aria-valuenow')).toBe('25')
    expect(within(dlg).getByText('42/168')).toBeTruthy()
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }))
    expect(onCancelPrepare).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancelPrepare).toHaveBeenCalledTimes(2)
    expect(p.onClose).not.toHaveBeenCalled()
  })

  it('cancels preparing with onClose when there is no onCancelPrepare', () => {
    const { p } = dialog({ stage: 'preparing' })
    expect(screen.getByText('…')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('shows the write as a percentage, and the read-back without one', () => {
    const { rerender } = dialog({ stage: 'writing' }, { busy: { op: 'write', done: 3, total: 12 } })
    const dlg = screen.getByRole('dialog', { name: '正在写入键盘' })
    expect(within(dlg).getByText('正在写入键盘，请不要拔线。')).toBeTruthy()
    expect(within(dlg).getByText('25%')).toBeTruthy()
    expect(dlg.textContent).not.toMatch(/报文|个键位/)
    expect(within(dlg).queryByRole('button')).toBeNull()

    rerender({ busy: { op: 'read', done: 84, total: 168 } })
    expect(screen.getByText('写入前先读取键盘里现在的键位，留作备份…')).toBeTruthy()
    expect(screen.getByText('50%')).toBeTruthy()

    rerender({ busy: { op: 'verify', done: 0, total: 0 } })
    expect(screen.getByText('写入完成，正在读回校验…')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
    expect(screen.getByText('…')).toBeTruthy()
  })

  it('keeps focus in the dialog when the focused button goes away', () => {
    const { rerender } = dialog({ stage: 'confirm' })
    const confirm = screen.getByRole('button', { name: '确认写入' })
    confirm.focus()
    expect(document.activeElement).toBe(confirm)
    rerender({ stage: { stage: 'writing' }, busy: { op: 'write', done: 0, total: 12 } })
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '正在写入键盘' }))
  })

  it('moves focus to the first line of the confirmation once the read before it is done', () => {
    const { rerender } = dialog({ stage: 'preparing' }, { busy: { op: 'read', done: 0, total: 168 } })
    screen.getByRole('button', { name: '取消' }).focus()
    rerender({ stage: { stage: 'confirm' }, busy: null })
    expect(document.activeElement).toBe(screen.getByText('将把页面上的键位写入键盘，有 1 个键位会改变：'))

    // The cautions come before the list of changes: focus starts there.
    rerender({ stage: { stage: 'preparing' } })
    rerender({ stage: { stage: 'confirm' }, cautions: ['Fn 层的 F12 不再是“办公/编程模式切换”。'] })
    expect(document.activeElement).toBe(screen.getByRole('group', { name: '写入后可能回不来' }))
  })
})

describe('WriteDialog: results', () => {
  it('announces how the write went: focus moves to the outcome heading, described by its sentence', () => {
    const outcomes: [WriteOutcome, string, string][] = [
      [{ kind: 'verified' }, '写入成功，已校验', '读回的键位和页面上完全一致。键盘现在是编程模式（M 灯亮），改动已经生效。'],
      [{ kind: 'office' }, '已写入，还没生效', '键盘现在是办公模式（M 灯灭），所以读回的是出厂键位。改动已经存进键盘，不需要重新写入：按住 Fn+F12 约 2 秒，M 灯亮起后点“M 灯已亮，重新校验”。'],
      [{ kind: 'mismatch', rows: [], incomplete: true }, '校验未通过', '读回时没有收到全部键位。请关闭 KB84 软件后再写一次。'],
      [{ kind: 'error', message: '键盘没有回应。' }, '写入中断', '键盘没有回应。键盘里的键位可能只写了一部分，页面上的修改还在。'],
    ]
    for (const [outcome, name, description] of outcomes) {
      const { rerender } = dialog({ stage: 'writing' }, { busy: { op: 'write', done: 6, total: 12 } })
      const dlg = screen.getByRole('dialog', { name: '正在写入键盘' })
      expect(document.activeElement).toBe(dlg)
      rerender({ stage: { stage: 'result', outcome }, busy: null })
      // The same dialog node: only its name and body change, so focus is what tells a screen reader.
      expect(screen.getByRole('dialog', { name: '写入结果' })).toBe(dlg)
      expect(document.activeElement).toBe(screen.getByRole('heading', { name, description }))
      cleanup()
    }
  })

  it('verified: says the change is live and lists up to 3 keys to try, then opens the key tester', () => {
    const onOpenTester = vi.fn()
    const { p } = result({ kind: 'verified' }, { written: [CAPS, F1, A, Q], onOpenTester })
    const dlg = screen.getByRole('dialog', { name: '写入结果' })
    expect(within(dlg).getByText('写入成功，已校验')).toBeTruthy()
    expect(within(dlg).getByText('读回的键位和页面上完全一致。键盘现在是编程模式（M 灯亮），改动已经生效。')).toBeTruthy()
    expect(within(dlg).getByRole('heading', { name: '试试刚改的键：' })).toBeTruthy()
    const tries = dlg.querySelectorAll('.write-try li')
    expect([...tries].map((li) => li.textContent)).toEqual([
      'Caps Lock → Esc：直接按 Caps Lock',
      'F1 → 静音：按住 Fn 再按 F1',
      'A → B：直接按 A',
    ])
    expect(within(dlg).getByText('以及另外 1 个键位。')).toBeTruthy()

    fireEvent.click(within(dlg).getByRole('button', { name: '打开按键测试' }))
    expect(onOpenTester).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dlg).getByRole('button', { name: '好的' }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('verified: does not claim the M light is on after writing the factory map, and lists nothing without written', () => {
    result({ kind: 'verified' }, { writtenIsFactory: true })
    expect(screen.getByText('读回的键位和页面上完全一致。在编程模式（M 灯亮）下就是这些键位。')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '试试刚改的键：' })).toBeNull()
    expect(screen.queryByRole('button', { name: '打开按键测试' })).toBeNull()
  })

  it('office: not live yet; 稍后 closes and the M-light button re-verifies', () => {
    const { p } = result({ kind: 'office' })
    const dlg = screen.getByRole('dialog', { name: '写入结果' })
    expect(within(dlg).getByText('已写入，还没生效')).toBeTruthy()
    expect(dlg.textContent).toContain('不需要重新写入')
    expect(within(dlg).queryByRole('button', { name: '好的' })).toBeNull()
    fireEvent.click(within(dlg).getByRole('button', { name: 'M 灯已亮，重新校验' }))
    expect(p.onReverify).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dlg).getByRole('button', { name: '稍后' }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('mismatch: shows the differences and 再写一次 retries', () => {
    const onRetry = vi.fn()
    result({ kind: 'mismatch', rows: [CAPS, A], incomplete: false }, { onRetry })
    const dlg = screen.getByRole('dialog', { name: '写入结果' })
    expect(within(dlg).getByText('校验未通过')).toBeTruthy()
    expect(within(dlg).getByText('读回的内容有 2 处与写入的不一致（见下表）。请关闭 KB84 软件后再写一次。')).toBeTruthy()
    expect(within(dlg).getByRole('columnheader', { name: '读回' })).toBeTruthy()
    fireEvent.click(within(dlg).getByRole('button', { name: '再写一次' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    cleanup()

    result({ kind: 'mismatch', rows: [], incomplete: true }, { onRetry })
    expect(screen.getByText('读回时没有收到全部键位。请关闭 KB84 软件后再写一次。')).toBeTruthy()
  })

  it('error: joins the message without a doubled 。 and 再写一次 retries', () => {
    const onRetry = vi.fn()
    result({ kind: 'error', message: '键盘没有回应。' }, { onRetry })
    const dlg = screen.getByRole('dialog', { name: '写入结果' })
    expect(within(dlg).getByText('写入中断')).toBeTruthy()
    expect(within(dlg).getByText('键盘没有回应。键盘里的键位可能只写了一部分，页面上的修改还在。')).toBeTruthy()
    fireEvent.click(within(dlg).getByRole('button', { name: '再写一次' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    cleanup()

    result({ kind: 'error', message: 'Device lost' })
    expect(screen.getByText('Device lost。键盘里的键位可能只写了一部分，页面上的修改还在。')).toBeTruthy()
    // Without onRetry, 关闭 is the main button.
    expect(screen.queryByRole('button', { name: '再写一次' })).toBeNull()
    expect(screen.getAllByRole('button', { name: '关闭' }).some((b) => b.className.includes('btn-ink'))).toBe(true)
  })

  it('error before anything was sent: says the keyboard got no change', () => {
    const onRetry = vi.fn()
    result({ kind: 'error', message: '还没有连接键盘。', partial: false }, { onRetry })
    const dlg = screen.getByRole('dialog', { name: '写入结果' })
    expect(within(dlg).getByText('还没有连接键盘。键盘没有收到任何改动，页面上的修改还在。')).toBeTruthy()
    expect(dlg.textContent).not.toContain('只写了一部分')
    fireEvent.click(within(dlg).getByRole('button', { name: '再写一次' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('error during 重新校验: nothing was written, so it offers 再校验一次 and never 再写一次', () => {
    const onRetry = vi.fn()
    const { p } = result({ kind: 'error', message: '读取超时。', reverify: true }, { onRetry })
    expect(screen.getByText('校验中断')).toBeTruthy()
    expect(screen.getByText('读取超时。这次只是读取，键盘里的键位没有改动。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '再写一次' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '再校验一次' }))
    expect(p.onReverify).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('every result says whether there is a backup and offers 改回写入前的键位 when there is', () => {
    const onRestoreBackup = vi.fn()
    const savedAt = Date.parse('2026-10-31T09:05:07')
    const outcomes: WriteOutcome[] = [
      { kind: 'verified' },
      { kind: 'office' },
      { kind: 'mismatch', rows: [CAPS], incomplete: false },
      { kind: 'error', message: '断开了' },
    ]
    for (const o of outcomes) {
      result(o, { backup: { savedAt, source: 'device' }, onRestoreBackup })
      const dlg = screen.getByRole('dialog', { name: '写入结果' })
      expect(within(dlg).getByText(`写入前的键位已自动备份（${formatSavedAt(savedAt)}）。`)).toBeTruthy()
      fireEvent.click(within(dlg).getByRole('button', { name: '改回写入前的键位' }))
      cleanup()
    }
    expect(onRestoreBackup).toHaveBeenCalledTimes(outcomes.length)

    result({ kind: 'verified' }, { backup: null, backupFailed: true, onRestoreBackup })
    expect(screen.getByText('这次没有自动备份。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '改回写入前的键位' })).toBeNull()
    cleanup()

    result({ kind: 'verified' })
    expect(document.querySelector('.write-backup-note')).toBeNull()
  })
})
