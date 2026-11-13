// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BulkMenu } from './BulkMenu'

afterEach(cleanup)

describe('BulkMenu', () => {
  it('offers both whole-board edits, moves with arrows and returns focus to 更多操作', () => {
    const onFactoryAll = vi.fn()
    const onClearAll = vi.fn()
    render(<BulkMenu onFactoryAll={onFactoryAll} onClearAll={onClearAll} />)
    const trigger = screen.getByRole('button', { name: '更多操作' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    expect(screen.getByRole('menu', { name: '更多操作' })).toBeTruthy()
    const items = screen.getAllByRole('menuitem')
    expect(items.map((i) => i.querySelector('span')!.textContent)).toEqual(['全部改回出厂键位', '全部清空…'])
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(items[1], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'End' })
    expect(document.activeElement).toBe(items[1])

    fireEvent.keyDown(items[1], { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.click(screen.getByRole('menuitem', { name: /全部清空/ }))
    expect(onClearAll).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /全部改回出厂键位/ }))
    expect(onFactoryAll).toHaveBeenCalledTimes(1)
    expect(onClearAll).toHaveBeenCalledTimes(1)
  })

  it('closes on a click outside and cannot open while disabled', () => {
    const { rerender } = render(<BulkMenu onFactoryAll={() => {}} onClearAll={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
    rerender(<BulkMenu onFactoryAll={() => {}} onClearAll={() => {}} disabled />)
    expect(screen.queryByRole('menu')).toBeNull()
    expect((screen.getByRole('button', { name: '更多操作' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
