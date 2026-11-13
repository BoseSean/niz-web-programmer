// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FormatIssue } from '../../format/types'
import { IssuesPanel } from './IssuesPanel'

afterEach(cleanup)

const ERROR: FormatIssue = { path: '/layers/base/caps', message: 'A combo needs an array of codes', severity: 'error' }
const WARNING: FormatIssue = { path: '/layers/fn/q', message: 'A wait after the last event is ignored', severity: 'warning' }

const head = () => screen.getByRole('button', { name: /个错误|条提示/ })

describe('IssuesPanel', () => {
  it('renders nothing without issues', () => {
    const { container } = render(<IssuesPanel issues={[]} onSelect={() => {}} />)
    expect(container.innerHTML).toBe('')
    expect(screen.queryByText(/可以写入/)).toBeNull()
  })

  it('leaves warnings alone collapsed, and says they do not block writing', () => {
    render(<IssuesPanel issues={[WARNING]} onSelect={() => {}} />)
    expect(document.getElementById('issues')).not.toBeNull()
    expect(head().textContent).toMatch(/^1 条提示（不影响写入）/)
    expect(head().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('opens for errors, also when they appear later, and jumps to a key', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<IssuesPanel issues={[WARNING]} onSelect={onSelect} />)
    rerender(<IssuesPanel issues={[ERROR, WARNING]} onSelect={onSelect} />)
    expect(head().textContent).toMatch(/^1 个错误需要修正后才能写入另有 1 条提示/)
    expect(head().getAttribute('aria-expanded')).toBe('true')
    expect(head().getAttribute('aria-controls')).toBe(screen.getByRole('list').id)
    fireEvent.click(screen.getByRole('button', { name: '基础层 · Caps Lock' }))
    expect(onSelect).toHaveBeenCalledWith('base', 'caps')
  })

  it('opens, scrolls into view and focuses its header on an open request', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    try {
      const { rerender } = render(<IssuesPanel issues={[ERROR]} onSelect={() => {}} openRequest={0} />)
      // collapsed by hand, then asked to open by the error pill
      fireEvent.click(head())
      expect(head().getAttribute('aria-expanded')).toBe('false')
      expect(scroll).not.toHaveBeenCalled()
      rerender(<IssuesPanel issues={[ERROR]} onSelect={() => {}} openRequest={1} />)
      expect(head().getAttribute('aria-expanded')).toBe('true')
      expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
      expect(document.activeElement).toBe(head())

      // already open: a new request still brings it into view
      head().blur()
      rerender(<IssuesPanel issues={[ERROR]} onSelect={() => {}} openRequest={2} />)
      expect(scroll).toHaveBeenCalledTimes(2)
      expect(document.activeElement).toBe(head())
      // an unrelated re-render does not
      rerender(<IssuesPanel issues={[ERROR, WARNING]} onSelect={() => {}} openRequest={2} />)
      expect(scroll).toHaveBeenCalledTimes(2)
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView
    }
  })
})
