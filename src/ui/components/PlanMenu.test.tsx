// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanMenu } from './PlanMenu'

afterEach(cleanup)

function setup() {
  const props = { onOpenProfiles: vi.fn(), onExportJson: vi.fn(), onExportPro: vi.fn(), onImportFile: vi.fn() }
  render(<PlanMenu {...props} />)
  return { ...props, trigger: screen.getByRole('button', { name: '方案' }) }
}

describe('PlanMenu', () => {
  it('groups the items under 方案 and 文件 and calls back with what was chosen', () => {
    const { trigger, onOpenProfiles, onExportJson, onExportPro } = setup()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu', { name: '方案' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const plans = within(menu).getByRole('group', { name: '方案（存在这个浏览器里）' })
    const files = within(menu).getByRole('group', { name: '文件' })
    expect(within(plans).getAllByRole('menuitem').map((i) => i.querySelector('span')?.textContent)).toEqual(['已保存的方案…', '自动备份…'])
    expect(within(files).getAllByRole('menuitem').map((i) => i.querySelector('span')?.textContent)).toEqual([
      '导出 JSON（完整）',
      '导出 JSON（只含改动）',
      '导出 KB84 .pro',
      '导入文件…',
    ])

    fireEvent.click(within(menu).getByRole('menuitem', { name: /自动备份/ }))
    expect(onOpenProfiles).toHaveBeenCalledWith('backups')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    const pick = (name: RegExp) => {
      fireEvent.click(trigger)
      fireEvent.click(screen.getByRole('menuitem', { name }))
    }
    pick(/已保存的方案/)
    expect(onOpenProfiles).toHaveBeenLastCalledWith('profiles')
    pick(/导出 JSON（完整）/)
    pick(/只含改动/)
    expect(onExportJson.mock.calls).toEqual([[true], [false]])
    pick(/^导出 KB84 \.pro/)
    expect(onExportPro).toHaveBeenCalledTimes(1)
  })

  it('focuses the first item, moves with arrows, and returns focus to 方案 on Esc', () => {
    const { trigger } = setup()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(6)
    expect(document.activeElement).toBe(items[0])
    expect(items.every((i) => i.tabIndex === -1)).toBe(true)

    fireEvent.keyDown(items[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[1])
    fireEvent.keyDown(items[1], { key: 'End' })
    expect(document.activeElement).toBe(items[5])
    fireEvent.keyDown(items[5], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(items[0])
    fireEvent.keyDown(items[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(items[5])
    fireEvent.keyDown(items[5], { key: 'Home' })
    expect(document.activeElement).toBe(items[0])

    // Esc closes the menu only: a window-level Esc handler (e.g. the key tester's) never sees it
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    fireEvent.keyDown(items[0], { key: 'Escape' })
    window.removeEventListener('keydown', onWindowKey)
    expect(onWindowKey).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on Tab and on a click outside', () => {
    const { trigger } = setup()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('imports .json and KB84 .pro through one file input', () => {
    const { trigger, onImportFile } = setup()
    const input = screen.getByTestId<HTMLInputElement>('import-file')
    expect(input.type).toBe('file')
    expect(input.accept.split(',')).toEqual(expect.arrayContaining(['.json', '.pro']))
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1)

    const click = vi.spyOn(input, 'click').mockImplementation(() => {})
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /导入文件/ }))
    expect(click).toHaveBeenCalledTimes(1)

    const pro = new File(['<xml/>'], 'mine.pro')
    const json = new File(['{}'], 'mine.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [pro] } })
    fireEvent.change(input, { target: { files: [json] } })
    expect(onImportFile.mock.calls).toEqual([[pro], [json]])
  })
})
