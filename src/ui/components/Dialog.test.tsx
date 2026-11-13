// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { Dialog } from './Dialog'

afterEach(cleanup)

/** A toolbar like App's: the dialog's button can disable (a read starts) or remove the button that opened it. */
function Toolbar({ then }: { then: 'keep' | 'disable' | 'remove' }) {
  const [open, setOpen] = useState(false)
  const [after, setAfter] = useState(false)
  return (
    <main>
      <nav aria-label="主要操作">
        <button type="button">导入文件</button>
        {!(after && then === 'remove') && (
          <button type="button" disabled={after && then === 'disable'} onClick={() => setOpen(true)}>
            读取键盘
          </button>
        )}
        <button type="button" disabled>撤销</button>
        <button type="button">方案</button>
      </nav>
      {open && (
        <Dialog
          title="读取键盘"
          onClose={() => setOpen(false)}
          footer={
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setAfter(true)
              }}
            >
              读取并替换
            </button>
          }
        >
          <p>页面上的修改会被替换。</p>
        </Dialog>
      )}
    </main>
  )
}

function openAndConfirm() {
  const read = screen.getByRole('button', { name: '读取键盘' })
  read.focus()
  fireEvent.click(read)
  expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '读取键盘' }))
  fireEvent.click(screen.getByRole('button', { name: '读取并替换' }))
  expect(screen.queryByRole('dialog')).toBeNull()
}

describe('Dialog: focus on close', () => {
  it('gives focus back to the button that opened it', () => {
    render(<Toolbar then="keep" />)
    openAndConfirm()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '读取键盘' }))
  })

  it('moves on to the next enabled button when that one is disabled now (the read it started is running)', () => {
    render(<Toolbar then="disable" />)
    openAndConfirm()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '方案' }))
  })

  it('falls back to a control where it was when that one is gone, not to <body>', () => {
    render(<Toolbar then="remove" />)
    openAndConfirm()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '导入文件' }))
  })
})
