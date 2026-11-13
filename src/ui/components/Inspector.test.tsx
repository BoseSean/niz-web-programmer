// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { factoryTable } from '../../device/layout'
import type { LayerId } from '../../device/types'
import type { Action } from '../../format/types'
import type { SlotTable } from '../../protocol/slots'
import { derive, factoryDraft, keyRef, type Draft } from '../state/editor'
import { KeyEditor } from './editors/KeyEditor'
import { Inspector } from './Inspector'

afterEach(cleanup)

const abc: Action = { type: 'macro', play: 'repeat', repeat: 1, interval: 30, steps: [{ tap: 'KeyA' }, { tap: 'KeyB' }, { tap: 'KeyC' }] }

interface HarnessProps {
  keyId: string
  layer?: LayerId
  edit?: (d: Draft) => void
  device?: SlotTable | null
  log?: (label: string, a: Action) => void
}

/** Keeps the draft, the layer and an undo stack in state, and remounts the inspector per layer like App does. */
function Harness({ keyId, layer: initialLayer = 'base', edit, device = null, log }: HarnessProps) {
  const [draft, setDraft] = useState(() => {
    const d = factoryDraft()
    edit?.(d)
    return d
  })
  const [past, setPast] = useState<Draft[]>([])
  const [layer, setLayer] = useState(initialLayer)
  const derived = derive(draft, device)
  const other = layer === 'base' ? 'fn' : 'base'
  const undo = () => {
    setDraft(past.at(-1)!)
    setPast(past.slice(0, -1))
  }
  return (
    <>
      <button type="button" disabled={!past.length} onClick={undo}>
        撤销
      </button>
      <Inspector
        key={`${layer}/${keyId}`}
        layer={layer}
        keyId={keyId}
        action={draft.layers[layer][keyId] ?? { type: 'none' }}
        otherAction={draft.layers[other][keyId] ?? { type: 'none' }}
        status={derived.status[layer][keyId]}
        issues={derived.issuesByKey.get(keyRef(layer, keyId)) ?? []}
        device={device}
        onChange={(a, label) => {
          log?.(label, a)
          setPast([...past, draft])
          setDraft({ ...draft, layers: { ...draft.layers, [layer]: { ...draft.layers[layer], [keyId]: a } } })
        }}
        onMirrorFn={() => {}}
        onLayer={setLayer}
      />
    </>
  )
}

const layers = () => screen.getByRole('radiogroup', { name: '这个键的两层' })
const typeGroup = () => screen.getByRole('radiogroup', { name: '动作类型' })

describe('Inspector header and the two layers', () => {
  it('names the Fn-layer key "Fn + …" and shows both layers with the current one checked', () => {
    render(<Harness keyId="caps" layer="fn" />)
    expect(screen.getByRole('heading', { name: 'Fn + Caps Lock' }).title).toBe('第 47 号键')
    const [base, fn] = within(layers()).getAllByRole('radio')
    expect(base.getAttribute('aria-checked')).toBe('false')
    expect(fn.getAttribute('aria-checked')).toBe('true')
    expect(base.getAttribute('aria-label')).toMatch(/^基础层：/)
    expect(base.tabIndex).toBe(-1)
    expect(fn.tabIndex).toBe(0)
    expect(within(fn).getByText('按住 Fn 再按 Caps Lock')).toBeTruthy()
    expect(screen.queryByRole('radiogroup', { name: '编辑哪一层' })).toBeNull()
    expect(screen.queryByText(/键位 #/)).toBeNull()
  })

  it('switches to the other layer from its row and keeps focus on the rows', () => {
    render(<Harness keyId="caps" />)
    expect(screen.getByRole('heading', { name: 'Caps Lock' })).toBeTruthy()
    fireEvent.click(within(layers()).getByRole('radio', { name: /^Fn 层/ }))
    expect(screen.getByRole('heading', { name: 'Fn + Caps Lock' })).toBeTruthy()
    const fn = within(layers()).getByRole('radio', { name: /^Fn 层/ })
    expect(fn.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(fn)

    fireEvent.keyDown(fn, { key: 'ArrowUp' })
    const base = within(layers()).getByRole('radio', { name: /^基础层/ })
    expect(base.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(base)
  })

  it('marks the other layer when it differs from the factory map or from the keyboard', () => {
    const device = factoryTable()
    render(<Harness keyId="caps" device={device} edit={(d) => (d.layers.fn.caps = { type: 'key', code: 'AudioVolumeUp' })} />)
    expect(within(layers()).getByRole('radio', { name: '基础层：大写锁定 (Caps Lock)' })).toBeTruthy()
    expect(within(layers()).getByRole('radio', { name: 'Fn 层：音量+（与出厂不同，未写入）' })).toBeTruthy()
  })
})

describe('Inspector state line', () => {
  it('shows only 出厂键位 for an untouched key', () => {
    render(<Harness keyId="caps" device={factoryTable()} />)
    expect(screen.getByText('出厂键位')).toBeTruthy()
    expect(screen.queryByText('未写入')).toBeNull()
    expect(screen.queryByRole('button', { name: '改回出厂' })).toBeNull()
    expect(screen.queryByRole('button', { name: '改回键盘里的' })).toBeNull()
  })

  it('offers 改回出厂 and 改回键盘里的 next to the difference', () => {
    const log = vi.fn()
    const device = factoryTable()
    device.base[46] = { kind: 'codes', codes: [43] } // the keyboard has Caps Lock → A
    render(<Harness keyId="caps" device={device} log={log} edit={(d) => (d.layers.base.caps = { type: 'key', code: 'Escape' })} />)
    expect(screen.getByText(/出厂是 大写锁定 \(Caps Lock\)/)).toBeTruthy()
    expect(screen.getByText(/键盘里现在是 A/)).toBeTruthy()
    expect(screen.getByText('未写入')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '改回键盘里的' }))
    expect(log).toHaveBeenLastCalledWith('改回键盘里的 基础层 · Caps Lock', { type: 'key', code: 'KeyA' })
    expect(screen.queryByText('未写入')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '改回出厂' }))
    expect(log).toHaveBeenLastCalledWith('改回出厂 基础层 · Caps Lock', { type: 'key', code: 'CapsLock' })
    expect(screen.getByText('出厂键位')).toBeTruthy()
    // the link went away with the difference; focus stays in the inspector
    expect(document.activeElement?.className).toBe('insp-state')
  })
})

describe('Inspector guards', () => {
  it('warns on the mode-switch key and restores it', () => {
    render(<Harness keyId="f12" layer="fn" />)
    expect(screen.getByText(/这是切换办公\/编程模式的键（按住 Fn\+F12 约 2 秒）。在编程模式下改掉它，可能就切不回办公模式了。/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /改回模式切换/ })).toBeNull()

    fireEvent.click(within(typeGroup()).getByRole('radio', { name: '无' }))
    fireEvent.click(screen.getByRole('button', { name: /改回模式切换/ }))
    expect(within(layers()).getByRole('radio', { name: 'Fn 层：办公/编程模式切换' })).toBeTruthy()
  })

  it('warns on the base layer of the Fn key only', () => {
    render(<Harness keyId="fn" />)
    expect(screen.getByText('这是 Fn 键。基础层上没有 Fn 键就进不了 Fn 层。')).toBeTruthy()
    fireEvent.click(within(layers()).getByRole('radio', { name: /^Fn 层/ }))
    expect(screen.queryByText(/这是 Fn 键/)).toBeNull()
  })

  it('does not warn on ordinary keys', () => {
    render(<Harness keyId="caps" />)
    expect(screen.queryByText(/切换办公\/编程模式/)).toBeNull()
    expect(screen.queryByText(/这是 Fn 键/)).toBeNull()
  })
})

describe('Inspector action type', () => {
  it('explains the chosen type under the type control', () => {
    render(<Harness keyId="caps" />)
    expect(screen.getByText('发送一个键：普通键、多媒体键、鼠标键或键盘功能。')).toBeTruthy()
    fireEvent.click(within(typeGroup()).getByRole('radio', { name: '无' }))
    expect(screen.getByText('这个键平时不做任何事。')).toBeTruthy()
    fireEvent.click(within(layers()).getByRole('radio', { name: /^Fn 层/ }))
    expect(screen.getByText('按住 Fn 再按这个键时没有反应。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /清除/ })).toBeNull()
  })

  it('says Ctrl+Z after a switch that drops content, until the next change or undo', () => {
    render(<Harness keyId="caps" edit={(d) => (d.layers.base.caps = structuredClone(abc))} />)
    const note = '切换类型丢掉了原来的内容，可按 Ctrl+Z 撤销。'
    fireEvent.click(within(typeGroup()).getByRole('radio', { name: '按键' }))
    expect(screen.getByRole('status').textContent).toBe(note)
    // key → combo keeps the code: the note goes away and does not come back
    fireEvent.click(within(typeGroup()).getByRole('radio', { name: '组合键' }))
    expect(screen.queryByText(note)).toBeNull()

    fireEvent.click(within(typeGroup()).getByRole('radio', { name: '无' }))
    expect(screen.getByText(note)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(screen.queryByText(note)).toBeNull()
  })

  it('does not show the note when a switch keeps everything', () => {
    render(<Harness keyId="caps" />)
    fireEvent.click(within(typeGroup()).getByRole('radio', { name: '宏' }))
    expect(screen.queryByText(/切换类型丢掉了原来的内容/)).toBeNull()
  })
})

describe('KeyEditor', () => {
  it('keeps codes and numbers out of the card and words the capture button by its effect', () => {
    const { container } = render(<KeyEditor action={{ type: 'key', code: 'Escape' }} onChange={() => {}} otherLayerHasFn={false} onMirrorFn={() => {}} />)
    const card = container.querySelector('.current-code') as HTMLElement
    expect(card.textContent).toBe('Esc现在是Esc')
    expect(card.textContent).not.toMatch(/0x/i)
    expect(card.title).toBe('Escape · 0x01')

    const capture = screen.getByRole('button', { name: '改成我按下的键' })
    expect(capture.getAttribute('aria-describedby')).toBeTruthy()
    expect(document.getElementById(capture.getAttribute('aria-describedby')!)?.textContent).toBe('只能录入普通键和多媒体键；鼠标、Fn 等请在下面的列表里选。')
    fireEvent.click(capture)
    expect(capture.textContent).toBe('请按下想要的键…（点此取消）')
    expect(capture.getAttribute('aria-pressed')).toBe('true')
  })
})
