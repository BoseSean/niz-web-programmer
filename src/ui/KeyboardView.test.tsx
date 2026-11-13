// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FACTORY, KEYS } from '../device/layout'
import type { LayerId } from '../device/types'
import { KeyboardView } from './KeyboardView'
import { buildFaces } from './lib/faces'
import { derive, factoryDraft, type Draft } from './state/editor'

afterEach(cleanup)

const facesOf = (draft: Draft, layer: LayerId = 'base') => buildFaces(draft, derive(draft, FACTORY).status, layer)
const key = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}：`) })

/** Select wiring as App does it: clicking the selected key again, or Esc, clears the selection. */
function Board({ onChange }: { onChange?: (id: string | null) => void }) {
  const [selected, setSelected] = useState<string | null>(null)
  const select = (id: string | null) => {
    const next = id === selected ? null : id
    setSelected(next)
    onChange?.(next)
  }
  return <KeyboardView keys={KEYS} faces={facesOf(factoryDraft())} selected={selected} onSelect={select} />
}

describe('KeyboardView', () => {
  it('draws the legend only on changed base keys and the Fn function in the corner', () => {
    const d = factoryDraft()
    const { rerender } = render(<KeyboardView keys={KEYS} faces={facesOf(d)} />)
    expect(key('Delete').querySelector('.kb-legend')).toBeNull()
    expect(key('Delete').querySelector('.kb-main')!.textContent).toBe('Del')
    expect(key('F1').querySelector('.kb-fn')!.textContent).toBe('PC')
    expect(key('F1').classList.contains('has-fn')).toBe(true)
    expect(key('F1').title).toBe('基础层：F1 / Fn 层：我的电脑')

    d.layers.base.delete = { type: 'key', code: 'Backspace' }
    rerender(<KeyboardView keys={KEYS} faces={facesOf(d)} />)
    expect(key('Delete').querySelector('.kb-legend')!.textContent).toBe('Delete')
    // the accessible name keeps its format
    expect(key('Delete').getAttribute('aria-label')).toBe('Delete：Bksp（与出厂不同，未写入）')
  })

  it('dims empty keys, draws the held key and labels the case', () => {
    const { rerender } = render(<KeyboardView keys={KEYS} faces={facesOf(factoryDraft(), 'fn')} />)
    expect(key('H').querySelector('.kb-main')!.textContent).toBe('·')
    expect(screen.getByText('NIZ · PLUM 84EC-S')).toBeTruthy()

    rerender(<KeyboardView keys={KEYS} faces={facesOf(factoryDraft(), 'fn')} dimEmpty heldKeyId="fn" caseLabel="Fn 层 · 按住 Fn 时生效" />)
    expect(key('H').querySelector('.kb-main')!.textContent).toBe('')
    expect(key('H').closest('.kb-case')!.classList.contains('dim-empty')).toBe(true)
    expect(key('Fn').classList.contains('is-held')).toBe(true)
    expect(key('Fn').classList.contains('is-pressed')).toBe(false)
    expect(screen.getByText('Fn 层 · 按住 Fn 时生效').getAttribute('aria-hidden')).toBe('true')
  })

  it('clears the selection on a second click and on Esc', () => {
    const onChange = vi.fn()
    render(<Board onChange={onChange} />)
    fireEvent.click(key('Caps Lock'))
    expect(key('Caps Lock').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(key('Caps Lock'))
    expect(key('Caps Lock').getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(key('A'))
    expect(key('A').getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(key('A'), { key: 'Escape' })
    expect(key('A').getAttribute('aria-pressed')).toBe('false')
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['caps', null, 'a', null])

    // nothing selected: Esc is left to others
    const outer = vi.fn()
    window.addEventListener('keydown', outer)
    fireEvent.keyDown(key('A'), { key: 'Escape' })
    window.removeEventListener('keydown', outer)
    expect(onChange).toHaveBeenCalledTimes(4)
    expect(outer.mock.calls[0][0].defaultPrevented).toBe(false)
  })

  it('selects nothing without onSelect (key tester, reading, writing)', () => {
    render(<KeyboardView keys={KEYS} faces={facesOf(factoryDraft())} selected="a" />)
    fireEvent.click(key('Caps Lock'))
    fireEvent.keyDown(key('A'), { key: 'Escape' })
    expect(key('A').getAttribute('aria-pressed')).toBe('true')
  })
})
