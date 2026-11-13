// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Action } from '../../format/types'
import { factoryDraft, type Draft } from '../state/editor'
import { addToLibrary } from '../state/library'
import { Dialog } from './Dialog'
import { LibraryQuick } from './editors/LibraryQuick'
import { LibraryPanel } from './LibraryPanel'

afterEach(cleanup)

const copy: Action = { type: 'combo', keys: ['ControlLeft', 'KeyC'] }
const tab = (shiftKey = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey })

describe('Dialog focus', () => {
  it('keeps Tab and Shift+Tab inside the dialog, also after focus fell back to the page', () => {
    render(
      <>
        <button type="button">页面上的按钮</button>
        <Dialog title="测试" onClose={() => {}} footer={<button type="button">好的</button>}>
          <input aria-label="名称" />
          <button type="button" disabled>不可用</button>
        </Dialog>
      </>,
    )
    const dialog = screen.getByRole('dialog', { name: '测试' })
    expect(document.activeElement).toBe(dialog)
    const close = screen.getByRole('button', { name: '关闭' })
    const ok = screen.getByRole('button', { name: '好的' })

    ok.focus()
    tab()
    expect(document.activeElement).toBe(close)
    tab(true)
    expect(document.activeElement).toBe(ok)

    // a deleted row leaves focus on <body>: the next Tab comes back into the dialog
    screen.getByRole('button', { name: '页面上的按钮' }).focus()
    tab()
    expect(document.activeElement).toBe(close)
  })
})

function LibHarness({ initial }: { initial: Draft }) {
  const [draft, setDraft] = useState(initial)
  return <LibraryPanel draft={draft} onApply={() => {}} onChange={(d) => setDraft(d)} />
}

describe('library focus', () => {
  it('returns focus to 重命名 after Enter / Escape, and to the heading after 删除', () => {
    render(<LibHarness initial={addToLibrary(factoryDraft(), copy).draft} />)
    const rename = screen.getByRole('button', { name: '重命名“组合键1”' })
    fireEvent.click(rename)
    fireEvent.keyDown(screen.getByRole('textbox', { name: '“组合键1”的新名称' }), { key: 'Escape' })
    expect(document.activeElement).toBe(rename)

    fireEvent.click(rename)
    const field = screen.getByRole('textbox', { name: '“组合键1”的新名称' })
    fireEvent.change(field, { target: { value: '复制' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '重命名“复制”' }))

    fireEvent.click(screen.getByRole('button', { name: '删除“复制”' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '动作库' }))
  })

  it('LibraryQuick gives focus back to 从动作库选择 when the list closes', () => {
    const draft = addToLibrary(factoryDraft(), copy).draft
    const onApply = vi.fn()
    render(<LibraryQuick draft={draft} action={{ type: 'none' }} where="基础层 · Q" onLibraryChange={() => {}} onApply={onApply} />)
    const toggle = screen.getByRole('button', { name: /从动作库选择/ })
    fireEvent.click(toggle)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(document.activeElement).toBe(toggle)
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: /组合键1/ }))
    expect(onApply).toHaveBeenCalledWith(copy, '把“组合键1”用到 基础层 · Q')
    expect(document.activeElement).toBe(toggle)
  })
})
