// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { codeById } from './device/codes'
import { FACTORY, keyById } from './device/layout'
import { parseProfileJson, profileToTable, serializeProfile, tableToProfile } from './format'
import { parseProFile } from './kb84/pro'
import { diffTables, encodeWriteSequence } from './protocol/codec'
import type { SessionOptions } from './protocol/session'
import type { SlotTable } from './protocol/slots'
import { SimulatedKeyboard, type KeyboardMode } from './transport/simulator'
import { toReport } from './transport/types'
import { memoryBackend, openLocalStore, type LocalStore } from './ui/state/localStore'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// import.meta.url is not a file: URL under jsdom; vitest runs from web/.
const readSample = (name: string) => readFileSync(resolve(process.cwd(), '../docs/re/samples', name), 'utf8')

const CAPS = keyById('caps')!.no - 1

/** A custom bank with A → B, so a read of it is not mistaken for the factory map. */
function customBank(): SlotTable {
  const program = { base: [...FACTORY.base], fn: [...FACTORY.fn] }
  program.base[keyById('a')!.no - 1] = { kind: 'codes', codes: [codeById('KeyB')!.value] }
  return program
}

function setup(mode: KeyboardMode = 'program', session: SessionOptions = {}, latencyMs = 0) {
  const kb = new SimulatedKeyboard({ latencyMs, mode })
  render(<App deviceOptions={{ createSimulator: () => kb, simulatorSession: { postWriteDelayMs: 0, ...session } }} />)
  return kb
}

interface HidOptions {
  /** The keyboard was chosen in an earlier visit, so the page connects to it on load (default true). */
  granted?: boolean
  session?: SessionOptions
  store?: LocalStore | Promise<LocalStore>
  /** What 使用模拟键盘 connects to. */
  simulator?: SimulatedKeyboard
}

/**
 * A real keyboard behind a fake navigator.hid: the simulated keyboard answers the WebHID reports. By default it is
 * authorised already, so the page connects to it on load (自动连接). `plug` unplugs it and plugs it back in, and
 * `failOpens` makes the next opens fail as if KB84 held it.
 */
function setupHid(kb: SimulatedKeyboard, opts: HidOptions = {}) {
  let chosen = opts.granted ?? true
  let fails = 0
  const events = new EventTarget()
  const report = { reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }
  const device = {
    vendorId: 0x0483,
    productId: 0x5025,
    productName: '84EC-S',
    opened: false,
    collections: [{ usagePage: 0x8c, usage: 1, inputReports: [report], outputReports: [report] }],
    addEventListener: (type: string, l: EventListener) => events.addEventListener(type, l),
    removeEventListener: (type: string, l: EventListener) => events.removeEventListener(type, l),
    async open() {
      if (fails > 0) {
        fails--
        throw new DOMException('Failed to open the device.', 'InvalidStateError')
      }
      device.opened = true
    },
    async close() {
      device.opened = false
    },
    async sendReport(_id: number, data: Uint8Array) {
      kb.handle(data)
    },
  }
  kb.onResponse = (p) => {
    const data = new DataView(toReport(p).slice().buffer)
    queueMicrotask(() => events.dispatchEvent(Object.assign(new Event('inputreport'), { reportId: 0, data })))
  }
  const hid = Object.assign(new EventTarget(), {
    getDevices: async () => (chosen ? [device] : []),
    requestDevice: async () => {
      chosen = true
      return [device]
    },
  })
  const store = opts.store ?? openLocalStore({ backend: memoryBackend() })
  const sim = opts.simulator
  render(
    <App
      store={store}
      deviceOptions={{
        hid: hid as unknown as HID,
        storage: null,
        session: { postWriteDelayMs: 0, ...opts.session },
        reconnectAttempts: 1,
        ...(sim && { createSimulator: () => sim, simulatorSession: { postWriteDelayMs: 0 } }),
      }}
    />,
  )
  const plug = (type: 'connect' | 'disconnect') => hid.dispatchEvent(Object.assign(new Event(type), { device }))
  const failOpens = (n: number) => {
    fails = n
  }
  return { store, plug, failOpens }
}

/** Records the command byte of every report the simulated keyboard receives. */
function spyCommands(kb: SimulatedKeyboard): number[] {
  const seen: number[] = []
  const handle = kb.handle.bind(kb)
  kb.handle = (p) => {
    seen.push(p[1])
    handle(p)
  }
  return seen
}

/** The keyboard drops every slot packet of a write; returns a function that ends that. */
function dropWrites(kb: SimulatedKeyboard): () => void {
  const handle = kb.handle.bind(kb)
  kb.handle = (p) => {
    if (p[1] !== 0xf0) handle(p)
  }
  return () => {
    kb.handle = handle
  }
}

/**
 * The keyboard's answers to reads lose the packet of one base-layer key (call it once connected: the transport sets
 * onResponse); returns a function that ends that.
 */
function dropReadSlot(kb: SimulatedKeyboard, keyId: string): () => void {
  const deliver = kb.onResponse!
  const no = keyById(keyId)!.no
  kb.onResponse = (p) => {
    if (!(p[1] === 0xf0 && p[2] === 1 && p[3] === no)) deliver(p)
  }
  return () => {
    kb.onResponse = deliver
  }
}

/** Captures the next download made through a Blob URL. */
function captureDownload(): Promise<{ name: string; text: string }> {
  return new Promise((resolve) => {
    let blob: Blob
    URL.createObjectURL = vi.fn((b: Blob) => ((blob = b), 'blob:test'))
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      void blob.text().then((text) => resolve({ name: this.download, text }))
    })
  })
}

const bar = () => document.querySelector<HTMLElement>('header.masthead')!
/** A button of the toolbar (the empty state repeats 读取键盘 and the dialogs have their own). */
const tool = (name: string | RegExp) => within(screen.getByRole('navigation', { name: '主要操作' })).getByRole('button', { name })
const isHot = (el: HTMLElement) => el.classList.contains('btn-primary')

async function connectSim() {
  fireEvent.click(within(bar()).getByRole('button', { name: /使用模拟键盘/ }))
  await within(bar()).findByRole('button', { name: /^已连接/ })
}

async function connectAndRead() {
  await connectSim()
  // The version request (F9) is never sent on its own.
  fireEvent.click(tool(/^读取键盘/))
}

/** Opens the 方案 menu and picks an item. */
function planMenu(item: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: '方案' }))
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
}

/** Opens the ⋯ menu next to the legend and picks an item. */
function bulkMenu(item: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
}

/** Selects Caps Lock and maps it to Escape through the code picker's search. */
function mapCapsToEscape() {
  // A second click on the selected key would deselect it.
  if (!screen.queryByRole('heading', { name: 'Caps Lock' })) fireEvent.click(screen.getByRole('button', { name: /^Caps Lock：/ }))
  const inspector = screen.getByRole('complementary', { name: '键位设置' })
  const search = within(inspector).getByRole('searchbox', { name: '搜索按键代码' })
  fireEvent.change(search, { target: { value: 'Escape' } })
  fireEvent.keyDown(search, { key: 'Enter' })
  return inspector
}

/** Selects a key and maps it to `code` through the code picker's search. */
function mapKey(label: string, code: string) {
  if (!screen.queryByRole('heading', { name: label })) fireEvent.click(keyButton(label))
  const search = within(screen.getByRole('complementary', { name: '键位设置' })).getByRole('searchbox', { name: '搜索按键代码' })
  fireEvent.change(search, { target: { value: code } })
  fireEvent.keyDown(search, { key: 'Enter' })
}

async function writeAndConfirm() {
  fireEvent.click(tool(/写入键盘/))
  const dialog = await screen.findByRole('dialog', { name: '写入键盘' })
  expect(await within(dialog).findByText('基础层 · Caps Lock')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: /确认写入/ }))
}

const keyButton = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}：`) })
const faceOf = (label: string) => keyButton(label).getAttribute('aria-label') ?? ''
const sync = () => screen.getByRole('navigation', { name: '主要操作' }).querySelector('.sync-wrap') as HTMLElement

describe('App with the simulated keyboard', () => {
  it('connects, reads, edits a key, writes and verifies', async () => {
    const kb = setup()
    await connectAndRead()
    // The simulator says it is in Program mode: a factory read is just the factory map, no Office-mode doubt.
    await screen.findByText('已读取键盘')
    expect(screen.queryByText('读到的是出厂键位')).toBeNull()

    const inspector = mapCapsToEscape()
    expect(within(inspector).getByText('未写入')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Caps Lock：Esc/ })).toBeTruthy()

    await writeAndConfirm()
    await screen.findByText('写入成功，已校验')
    expect(kb.getBank('program').base[CAPS]).toEqual({ kind: 'codes', codes: [1] })
    expect(screen.getByLabelText(/^Caps Lock：Esc（与出厂不同）$/)).toBeTruthy()
  })

  it('explains Office mode after a write, and re-verifies from the result or later from the M light', async () => {
    const kb = setup('office')
    await connectAndRead()
    await screen.findByText('读到的是出厂键位')
    mapCapsToEscape()
    await writeAndConfirm()
    await screen.findByText('已写入，还没生效')
    expect(kb.getBank('program').base[CAPS]).toEqual({ kind: 'codes', codes: [1] })

    // 稍后: 重新校验 stays offered next to the M light.
    fireEvent.click(screen.getByRole('button', { name: '稍后' }))
    kb.setMode('program')
    fireEvent.click(within(bar()).getByRole('button', { name: '两种模式的说明' }))
    fireEvent.click(await screen.findByRole('button', { name: /M 灯已亮，重新校验/ }))
    await screen.findByText('写入成功，已校验')
    expect(screen.getByText('已写入并校验')).toBeTruthy()
  })

  it('undoes and redoes edits with Ctrl+Z / Ctrl+Shift+Z and switches layers with 1 / 2', async () => {
    setup()
    mapCapsToEscape()
    expect(screen.getByRole('button', { name: /^Caps Lock：Esc/ })).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(screen.getByRole('button', { name: /^Caps Lock：Caps$/ })).toBeTruthy())
    fireEvent.keyDown(document.body, { key: 'Z', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(screen.getByRole('button', { name: /^Caps Lock：Esc/ })).toBeTruthy())

    fireEvent.keyDown(document.body, { key: '2' })
    await screen.findByRole('group', { name: /Fn 层/ })
  })

  it('deselects a key on a second click and on Esc', () => {
    setup()
    fireEvent.click(keyButton('Q'))
    expect(screen.getByRole('heading', { name: 'Q' })).toBeTruthy()
    fireEvent.click(keyButton('Q'))
    expect(screen.getByRole('heading', { name: '从这里开始' })).toBeTruthy()
    fireEvent.click(keyButton('Q'))
    fireEvent.keyDown(keyButton('Q'), { key: 'Escape' })
    expect(screen.getByRole('heading', { name: '从这里开始' })).toBeTruthy()
  })

  it('blocks writing while there are validation errors', async () => {
    setup()
    await connectAndRead()
    await screen.findByText('已读取键盘')
    fireEvent.click(screen.getByRole('button', { name: /^Caps Lock：/ }))
    fireEvent.click(screen.getByRole('radio', { name: '组合键' }))
    await screen.findByText(/个错误需要修正后才能写入/)
    expect((tool(/写入键盘/) as HTMLButtonElement).disabled).toBe(true)
    expect(isHot(tool(/写入键盘/))).toBe(false)
    expect(within(sync()).getByText('1 个错误，改正后才能写入')).toBeTruthy()
  })

  it('sends the version request (F9) only when asked', async () => {
    const kb = setup()
    const seen = spyCommands(kb)
    await connectAndRead()
    await screen.findByText('已读取键盘')
    expect(seen).not.toContain(0xf9)
    fireEvent.click(within(bar()).getByRole('button', { name: /^已连接/ }))
    fireEvent.click(screen.getByRole('button', { name: '查询固件版本' }))
    await screen.findByText(/固件版本：SIM-84EC-S 1\.0/)
    expect(seen.filter((c) => c === 0xf9)).toHaveLength(1)
  })

  it('imports a KB84 .pro file, writes it and the keyboard holds exactly that table', async () => {
    const kb = setup()
    await connectAndRead()
    await screen.findByText('已读取键盘')
    const file = new File([readSample('test.pro')], 'test.pro')
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [file] } })
    await screen.findByText(/^已导入 test\.pro/)
    expect(screen.getByText('页面上：导入 test.pro')).toBeTruthy()

    fireEvent.keyDown(document.body, { key: '2' })
    expect(screen.getByRole('button', { name: /^H：.*（与出厂不同，未写入）$/ })).toBeTruthy()

    fireEvent.click(tool(/写入键盘/))
    const dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    expect(within(dialog).getByText(/有 5 个键位会改变/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: /确认写入/ }))
    await screen.findByText('写入成功，已校验')
    const expected = profileToTable(parseProFile(readSample('test.pro')).profile!)
    expect(diffTables(kb.getBank('program'), expected)).toEqual([])
  })

  it('exports JSON that imports back to the same table', async () => {
    setup()
    mapCapsToEscape()
    const download = captureDownload()
    planMenu(/导出 JSON（完整）/)
    const { name, text } = await download
    expect(name).toMatch(/^84ec-s-\d{8}-\d{4}\.json$/)
    const { profile, issues } = parseProfileJson(text)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(profileToTable(profile!).base[CAPS]).toEqual({ kind: 'codes', codes: [1] })
  })

  it('reports a keyboard that does not answer and keeps edits after disconnecting', async () => {
    const kb = setup('program', { firstTimeoutMs: 20 })
    await connectAndRead()
    await screen.findByText('已读取键盘')
    mapCapsToEscape()
    kb.muted = true
    fireEvent.click(tool(/^读取键盘/))
    // One unwritten change: confirm replacing it with the keyboard's contents.
    fireEvent.click(await screen.findByRole('button', { name: '读取并替换' }))
    await screen.findByText('读取失败')
    expect(screen.getByText(/和键盘通信出错/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Caps Lock：Esc/ })).toBeTruthy()

    fireEvent.click(within(bar()).getByRole('button', { name: /^已连接/ }))
    fireEvent.click(screen.getByRole('button', { name: /断开/ }))
    await screen.findByText('未连接')
    expect(screen.getByRole('button', { name: /^Caps Lock：Esc/ })).toBeTruthy()
    expect((tool(/^读取键盘/) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('App: the next step and the sync status', () => {
  it('lights one primary button and says how the page relates to the keyboard', async () => {
    const kb = setup()
    expect(within(sync()).getByText('未连接键盘')).toBeTruthy()
    expect(isHot(tool(/^读取键盘/)) || isHot(tool(/写入键盘/))).toBe(false)

    await connectSim()
    // Nothing known and nothing edited: read first.
    expect(isHot(tool(/^读取键盘/))).toBe(true)
    expect(isHot(tool(/写入键盘/))).toBe(false)
    expect(within(sync()).getByText('还没读取键盘')).toBeTruthy()

    // Edited before any read: writing (which reads first) is the next step, not a read that replaces the edits.
    mapCapsToEscape()
    expect(within(sync()).getByText('页面上有 1 处修改 · 写入前会先读取键盘')).toBeTruthy()
    expect(isHot(tool(/写入键盘/))).toBe(true)
    expect(isHot(tool(/^读取键盘/))).toBe(false)
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })

    fireEvent.click(tool(/^读取键盘/))
    await within(sync()).findByText('与键盘一致')
    expect(isHot(tool(/^读取键盘/)) || isHot(tool(/写入键盘/))).toBe(false)
    expect(screen.getByText(/^页面上：读取的键盘 \d\d:\d\d$/)).toBeTruthy()

    mapCapsToEscape()
    const pill = within(sync()).getByRole('button', { name: /1 处修改未写入/ })
    expect(isHot(tool(/写入键盘/))).toBe(true)
    // The pill lists the unwritten changes; a row selects its key.
    fireEvent.click(keyButton('Q'))
    fireEvent.click(pill)
    fireEvent.click(within(screen.getByRole('menu', { name: '未写入的修改' })).getByRole('menuitem', { name: /基础层 · Caps Lock/ }))
    expect(screen.getByRole('heading', { name: 'Caps Lock' })).toBeTruthy()

    await writeAndConfirm()
    await screen.findByText('写入成功，已校验')
    fireEvent.click(screen.getByRole('button', { name: '好的' }))
    expect(within(sync()).getByText('已写入并校验')).toBeTruthy()
    expect(kb.getBank('program').base[CAPS]).toEqual({ kind: 'codes', codes: [1] })

    // A later read says the same table, but no longer "just written".
    fireEvent.click(tool(/^读取键盘/))
    await within(sync()).findByText('与键盘一致')
  })

  it('marks the keyboard unknown after a broken write and reads it again before the next one', async () => {
    const kb = setup('program', { firstTimeoutMs: 20 })
    await connectAndRead()
    await screen.findByText('已读取键盘')
    mapCapsToEscape()
    kb.muted = true
    await writeAndConfirm()
    await screen.findByText('写入中断')
    fireEvent.click(within(screen.getByRole('dialog', { name: '写入结果' })).getAllByRole('button', { name: '关闭' })[0])
    expect(within(sync()).getByRole('button', { name: '键盘状态未知 · 建议重新读取' })).toBeTruthy()

    kb.muted = false
    const seen = spyCommands(kb)
    fireEvent.click(tool(/写入键盘/))
    await screen.findByRole('button', { name: /确认写入/ })
    // read first (F2): the dialog compares with the keyboard as it is now
    expect(seen).toEqual(expect.arrayContaining([0xf2]))
    expect(seen).not.toContain(0xf1)
    fireEvent.click(screen.getByRole('button', { name: /确认写入/ }))
    await screen.findByText('写入成功，已校验')
    expect(seen.filter((c) => c === 0xf2 || c === 0xf1)).toEqual([0xf2, 0xf1, 0xf2])
  })

  it('cancels the read before a write: the dialog closes and does not come back', async () => {
    setup('program', {}, 1)
    await connectSim()
    mapCapsToEscape()
    fireEvent.click(tool(/写入键盘/))
    const dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    expect(within(dialog).getByText(/正在读取键盘里现在的键位/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    // The read still lands (the keyboard's table is known now), but the confirmation stays closed.
    await within(sync()).findByText('1 处修改未写入', {}, { timeout: 4000 })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(faceOf('Caps Lock')).toMatch(/^Caps Lock：Esc/)
  })
})

describe('App: the M light (Program / Office mode)', () => {
  it('a factory read after a known custom bank keeps the page and says the keyboard is in Office mode', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'program', program: customBank() })
    setupHid(kb)
    await within(bar()).findByRole('button', { name: /^已连接/ })
    expect(within(bar()).getByRole('button', { name: /M 灯 · 读取前请确认亮着/ })).toBeTruthy()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('已读取键盘')
    expect(faceOf('A')).toMatch(/^A：B/)
    expect(within(bar()).getByRole('button', { name: /编程模式 · M 灯亮/ })).toBeTruthy()

    // Someone holds Fn+F12: the keyboard now reads the factory map.
    kb.setMode('office')
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('页面上的键位保持不变')
    expect(screen.getByText(/键盘现在多半是办公模式/)).toBeTruthy()
    expect(faceOf('A')).toMatch(/^A：B/)
    expect(within(bar()).getByRole('button', { name: /办公模式 · M 灯灭/ })).toBeTruthy()
    expect(within(sync()).getByText('与键盘一致')).toBeTruthy()

    // Writing now warns about Office mode; the comparison is still with the user's keys.
    fireEvent.click(tool(/写入键盘/))
    const dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    expect(within(dialog).getByText(/键盘现在多半是办公模式/)).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: /仍然写入/ })).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: /确认写入/ })).toBeNull()
  })

  it('doubts a factory read of an unknown keyboard until the user confirms the M light', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'program' })
    setupHid(kb)
    await within(bar()).findByRole('button', { name: /^已连接/ })
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('读到的是出厂键位')
    expect(within(bar()).getByRole('button', { name: /读到出厂键位 · M 灯亮着吗/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'M 灯亮着，继续' }))
    expect(within(bar()).getByRole('button', { name: /编程模式 · M 灯亮/ })).toBeTruthy()
    expect(screen.queryByText('读到的是出厂键位')).toBeNull()
  })

  it('先重新读取键盘 reads the keyboard again but keeps the edits on the page', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'office', program: customBank() })
    setupHid(kb)
    await within(bar()).findByRole('button', { name: /^已连接/ })
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('读到的是出厂键位')
    mapCapsToEscape()
    fireEvent.click(tool(/写入键盘/))
    let dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    expect(within(dialog).getByRole('button', { name: /仍然写入/ })).toBeTruthy()

    kb.setMode('program')
    fireEvent.click(within(dialog).getByRole('button', { name: /先重新读取键盘/ }))
    // The real custom bank is the baseline now: A goes back to A, Caps becomes Esc; no more doubt about the mode.
    fireEvent.click(await screen.findByRole('button', { name: /确认写入/ }))
    dialog = await screen.findByRole('dialog', { name: '写入结果' })
    await within(dialog).findByText('写入成功，已校验')
    expect(faceOf('Caps Lock')).toMatch(/^Caps Lock：Esc/)
    expect(faceOf('A')).toMatch(/^A：A/)
    expect(kb.getBank('program').base[CAPS]).toEqual({ kind: 'codes', codes: [1] })
    expect(within(bar()).getByRole('button', { name: /编程模式 · M 灯亮/ })).toBeTruthy()
  })

  it('the simulator takes its mode from its own M switch, not from reads', async () => {
    setup()
    await connectAndRead()
    await screen.findByText('已读取键盘')
    // ② is done because the simulator says Program mode.
    expect(screen.getByText('确认 F12 上的 M 灯亮着').closest('li')!.className).toBe('is-done')
    mapCapsToEscape()
    fireEvent.click(tool(/写入键盘/))
    expect(await screen.findByRole('button', { name: /确认写入/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    fireEvent.click(within(bar()).getByRole('button', { name: /编程模式/, pressed: true }))
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('读到的是出厂键位')
    expect(screen.getByText(/模拟键盘现在是办公模式/)).toBeTruthy()
    fireEvent.click(keyButton('Q'))
    fireEvent.click(keyButton('Q'))
    expect(screen.getByText('确认 F12 上的 M 灯亮着').closest('li')!.className).toBe('is-current')
  })
})

describe('App: notices', () => {
  const importJson = (name: string, map: SlotTable) =>
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [new File([serializeProfile(tableToProfile(map), { style: 'full', schemaUrl: null })], name)] } })

  it('closes ok notices after 6 s, and on the next edit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setup()
    importJson('a.json', customBank())
    await screen.findByText('已导入 a.json')
    act(() => vi.advanceTimersByTime(6100))
    expect(screen.queryByText('已导入 a.json')).toBeNull()

    importJson('b.json', customBank())
    await screen.findByText('已导入 b.json')
    mapCapsToEscape()
    expect(screen.queryByText('已导入 b.json')).toBeNull()
  })

  it('offers 撤销 only while its own change is the one that would be undone', async () => {
    setup()
    bulkMenu(/全部清空/)
    const clear = await screen.findByRole('dialog', { name: '全部清空' })
    fireEvent.click(within(clear).getByRole('checkbox', { name: '连 Fn 和模式切换也清空' }))
    fireEvent.click(within(clear).getByRole('button', { name: /全部清空（含 Fn）/ }))
    const notice = (await screen.findByText('已清空全部键位（包括 Fn 和模式切换）')).closest('.notice') as HTMLElement
    expect(within(notice).getByRole('button', { name: '撤销' })).toBeTruthy()

    // An edit after it: 撤销 would undo that edit, so it is not offered (the warning stays).
    fireEvent.click(keyButton('Q'))
    fireEvent.click(within(screen.getByRole('complementary', { name: '键位设置' })).getByRole('radio', { name: '按键' }))
    expect(within(notice).queryByRole('button', { name: '撤销' })).toBeNull()
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    fireEvent.click(await within(notice).findByRole('button', { name: '撤销' }))
    expect(faceOf('Fn')).toMatch(/^Fn：Fn/)
    expect(screen.queryByText('已清空全部键位（包括 Fn 和模式切换）')).toBeNull()
  })

  it('says when a file replaces the library', async () => {
    setup()
    fireEvent.click(keyButton('Caps Lock'))
    const inspector = screen.getByRole('complementary', { name: '键位设置' })
    fireEvent.click(within(inspector).getByRole('radio', { name: '宏' }))
    fireEvent.click(within(inspector).getByRole('button', { name: /存入动作库/ }))
    importJson('c.json', customBank())
    await screen.findByText('动作库也换成了文件里的（可撤销）。')
  })
})

describe('App v1.1: library, backups, clear-all and the key tester', () => {
  function setupWithStore(program?: SlotTable) {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'program', program })
    const store = openLocalStore({ backend: memoryBackend() })
    render(<App store={store} deviceOptions={{ createSimulator: () => kb, simulatorSession: { postWriteDelayMs: 0 } }} />)
    return { kb, store }
  }
  const inspector = () => screen.getByRole('complementary', { name: '键位设置' })

  /** Caps Lock → a one-step macro, then 存入动作库 from the macro editor. */
  async function saveCapsMacro() {
    fireEvent.click(keyButton('Caps Lock'))
    fireEvent.click(within(inspector()).getByRole('radio', { name: '宏' }))
    fireEvent.click(within(inspector()).getByRole('button', { name: /存入动作库/ }))
    await within(inspector()).findByText('与动作库中的“宏1”相同')
  }

  it('saves a macro, applies it, writes with a backup, clears all keeping Fn, and tests keys', async () => {
    const { kb, store } = setupWithStore()
    await connectAndRead()
    await screen.findByText('已读取键盘')

    // --- library: save the macro, apply it to Q from the 动作库 panel and to W from the inspector's picker
    await saveCapsMacro()
    expect((within(inspector()).getByRole('button', { name: /存入动作库/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(keyButton('Q'))
    fireEvent.click(screen.getByRole('radio', { name: /^动作库/ }))
    const lib = screen.getByRole('complementary', { name: '动作库' })
    expect(within(lib).getByText('当前键：基础层 · Q')).toBeTruthy()
    fireEvent.click(within(lib).getByRole('button', { name: '把“宏1”用到当前键' }))
    expect(faceOf('Q')).toMatch(/未写入/)
    fireEvent.click(within(lib).getByText('用于 2 个键'))
    expect(within(lib).getByRole('button', { name: '基础层 · Q' })).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: '键位设置' }))

    fireEvent.click(keyButton('W'))
    fireEvent.click(within(inspector()).getByRole('button', { name: /从动作库选择/ }))
    fireEvent.click(within(inspector()).getByRole('button', { name: /^宏1/ }))
    expect(within(inspector()).getByText('与动作库中的“宏1”相同')).toBeTruthy()
    // applying is an undoable editor change
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(within(inspector()).queryByText('与动作库中的“宏1”相同')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重做' }))

    // --- write: a pre-write backup of the read table is taken, then the write verifies
    fireEvent.click(tool(/写入键盘/))
    const dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    expect(within(dialog).getByText(/有 3 个键位会改变/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: /确认写入/ }))
    await screen.findByText('写入成功，已校验')
    expect(kb.getBank('program').base[keyById('q')!.no - 1].kind).toBe('macro')
    const backups = await (await store).listBackups()
    expect(backups).toHaveLength(1)
    expect(backups[0].note).toBe('写入前自动备份')
    const restored = await (await store).restoreBackup(backups[0].id)
    expect(diffTables(profileToTable(restored.profile!), FACTORY)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '好的' }))

    planMenu(/自动备份/)
    const pd = await screen.findByRole('dialog', { name: '方案' })
    expect(within(pd).getByRole('tab', { name: /自动备份/ }).getAttribute('aria-selected')).toBe('true')
    expect((await within(pd).findAllByText(/^写入之前/)).length).toBeGreaterThan(0)
    fireEvent.click(within(pd).getAllByRole('button', { name: '关闭' })[0])
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '方案' })).toBeNull())

    // --- clear all: Fn on both layers and Fn+F12 survive, the library too
    bulkMenu(/全部清空/)
    const clear = await screen.findByRole('dialog', { name: '全部清空' })
    expect(within(clear).getByText(/保留：/).textContent).toContain('Fn 层 · F12（办公/编程模式切换）')
    fireEvent.click(within(clear).getByRole('button', { name: /^全部清空$/ }))
    await screen.findByText('已清空全部键位')
    expect(faceOf('Caps Lock')).toMatch(/^Caps Lock：无/)
    expect(faceOf('Fn')).toMatch(/^Fn：Fn/)
    expect(screen.getByRole('radio', { name: /^动作库/ }).textContent).toContain('1')
    fireEvent.keyDown(document.body, { key: '2' })
    await screen.findByRole('group', { name: /Fn 层/ })
    expect(faceOf('F12')).not.toMatch(/^F12：无/)
    expect(faceOf('Fn')).toMatch(/^Fn：Fn/)
    fireEvent.keyDown(document.body, { key: '1' })
    await screen.findByRole('group', { name: /基础层/ })

    // --- key tester: KeyA lights 'a'; 2 and Ctrl+Z are test presses, not commands; Esc Esc exits
    fireEvent.click(screen.getByRole('radio', { name: '按键测试' }))
    const tester = screen.getByRole('complementary', { name: '按键测试' })
    expect(within(tester).getByText('正在测试，直接按键盘')).toBeTruthy()
    fireEvent.keyDown(window, { code: 'KeyA', key: 'a' })
    await waitFor(() => expect(keyButton('A').classList.contains('is-pressed')).toBe(true))
    expect((tester.querySelector('.kt-last-zh') as HTMLElement).textContent).toBe('A')
    fireEvent.keyUp(window, { code: 'KeyA', key: 'a' })
    fireEvent.keyDown(document.body, { code: 'Digit2', key: '2' })
    fireEvent.keyDown(document.body, { code: 'KeyZ', key: 'z', ctrlKey: true })
    expect(screen.getByRole('group', { name: /基础层/ })).toBeTruthy()
    expect(faceOf('Caps Lock')).toMatch(/^Caps Lock：无/)

    fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' })
    fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' })
    await waitFor(() => expect(screen.getByRole('complementary', { name: '键位设置' })).toBeTruthy())
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: '键位设置' }))
    expect(keyButton('A').classList.contains('is-pressed')).toBe(false)
    // shortcuts work again: undo the clear-all
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(faceOf('Caps Lock')).not.toMatch(/^Caps Lock：无/))
  })

  it('clears Fn and the mode switch too when asked, with a warning', async () => {
    setupWithStore()
    bulkMenu(/全部清空/)
    const clear = await screen.findByRole('dialog', { name: '全部清空' })
    fireEvent.click(within(clear).getByRole('checkbox', { name: '连 Fn 和模式切换也清空' }))
    expect(within(clear).getByRole('alert').textContent).toMatch(/无法进入 Fn 层[\s\S]*Esc[\s\S]*Delete/)
    fireEvent.click(within(clear).getByRole('button', { name: /全部清空（含 Fn）/ }))
    await screen.findByText('已清空全部键位（包括 Fn 和模式切换）')
    expect(faceOf('Fn')).toMatch(/^Fn：无/)
  })

  it('offers 改回写入前的键位 after a mismatched write and puts the pre-write keys back on the page', async () => {
    // A custom bank (A → B), so the unchanged read-back is not mistaken for Office mode.
    const { kb } = setupWithStore(customBank())
    await connectAndRead()
    await screen.findByText('已读取键盘')
    mapCapsToEscape()
    // The keyboard drops every slot packet of the write: the read-back still holds the old table.
    dropWrites(kb)
    await writeAndConfirm()
    const result = await screen.findByRole('dialog', { name: '写入结果' })
    await within(result).findByText('校验未通过')
    expect(within(result).getByText(/写入前的键位已自动备份/)).toBeTruthy()
    fireEvent.click(within(result).getByRole('button', { name: '改回写入前的键位' }))
    // Back to the confirmation, so writing the restored keys is one more click.
    const dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    expect(within(dialog).getByRole('button', { name: /确认写入/ })).toBeTruthy()
    expect(faceOf('Caps Lock')).toMatch(/^Caps Lock：Caps/)
    expect(faceOf('A')).toMatch(/^A：B/)
  })

  it('再写一次 keeps the backup of the first attempt', async () => {
    const { kb, store } = setupWithStore(customBank())
    await connectAndRead()
    await screen.findByText('已读取键盘')
    mapCapsToEscape()
    const restore = dropWrites(kb)
    await writeAndConfirm()
    let result = await screen.findByRole('dialog', { name: '写入结果' })
    await within(result).findByText('校验未通过')
    restore()
    fireEvent.click(within(result).getByRole('button', { name: /再写一次/ }))
    result = await screen.findByRole('dialog', { name: '写入结果' })
    await within(result).findByText('写入成功，已校验')
    expect(await (await store).listBackups()).toHaveLength(1)
    // The backup is still what the keyboard held before the first attempt.
    fireEvent.click(within(result).getByRole('button', { name: '改回写入前的键位' }))
    await screen.findByRole('dialog', { name: '写入键盘' })
    expect(faceOf('Caps Lock')).toMatch(/^Caps Lock：Caps/)
    expect(faceOf('A')).toMatch(/^A：B/)
  })

  it('reads a keyboard that was never read before writing: true changes, and the backup holds what was on it (review regression)', async () => {
    const program = customBank()
    const { kb, store } = setupWithStore(program)
    const seen = spyCommands(kb)
    await connectSim()
    mapCapsToEscape()
    // The keyboard is read before the confirmation, so it lists what really changes on it: A goes back to A too.
    fireEvent.click(tool(/写入键盘/))
    const confirm = await screen.findByRole('button', { name: /确认写入/ })
    const dialog = screen.getByRole('dialog', { name: '写入键盘' })
    expect(within(dialog).getByText(/将把页面上的键位写入键盘，有 2 个键位会改变/)).toBeTruthy()
    expect(within(dialog).getByText('基础层 · A')).toBeTruthy()
    fireEvent.click(confirm)
    await screen.findByText('写入成功，已校验')
    // read (F2) before the confirmation, write (F1), read back (F2)
    expect(seen.filter((c) => c === 0xf2 || c === 0xf1)).toEqual([0xf2, 0xf1, 0xf2])
    const backups = await (await store).listBackups()
    expect(backups).toHaveLength(1)
    // Simulator backups are kept apart from the real keyboard's.
    expect(backups[0].target).toBe('simulator')
    const restored = await (await store).restoreBackup(backups[0].id)
    expect(diffTables(profileToTable(restored.profile!), program)).toEqual([])
  })

  it('restoring the pre-write backup keeps the own name of the draft and library (review regression)', async () => {
    const { kb } = setupWithStore(customBank())
    await connectAndRead()
    await screen.findByText('已读取键盘')
    await saveCapsMacro()
    dropWrites(kb)
    fireEvent.click(tool(/写入键盘/))
    fireEvent.click(within(await screen.findByRole('dialog', { name: '写入键盘' })).getByRole('button', { name: /确认写入/ }))
    const result = await screen.findByRole('dialog', { name: '写入结果' })
    await within(result).findByText('校验未通过')
    fireEvent.click(within(result).getByRole('button', { name: '改回写入前的键位' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: '写入键盘' })).getByRole('button', { name: '取消' }))
    expect(screen.getByText('页面上：写入前的键位')).toBeTruthy()

    const download = captureDownload()
    planMenu(/导出 JSON（完整）/)
    const restored = parseProfileJson((await download).text).profile!
    // The backup's internal note is not the user's profile name.
    expect(restored.name).toBeUndefined()
    expect(restored.library?.macros?.[0].name).toBe('宏1')
    expect(restored.layers.base.a).toEqual({ type: 'key', code: 'KeyB' })
  })

  it('carries the library in JSON and KB84 .pro exports and imports it back', async () => {
    setupWithStore()
    await saveCapsMacro()
    let download = captureDownload()
    planMenu(/导出 JSON（完整）/)
    const json = await download
    expect(parseProfileJson(json.text).profile!.library?.macros?.[0].name).toBe('宏1')

    download = captureDownload()
    planMenu(/导出 KB84 .pro/)
    const pro = await download
    expect(pro.text).toMatch(/<PredefinedMacro>[\s\S]*宏1[\s\S]*<\/PredefinedMacro>/)
    expect(parseProFile(pro.text).profile!.library?.macros?.[0].name).toBe('宏1')

    // A file without a library replaces it (undoable, and said so); importing ours brings it back.
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [new File([readSample('test.pro')], 'test.pro')] } })
    await screen.findByText(/^已导入 test\.pro/)
    fireEvent.change(screen.getByTestId('import-file'), { target: { files: [new File([json.text], 'mine.json')] } })
    await screen.findByText(/^已导入 mine\.json/)
    fireEvent.click(screen.getByRole('radio', { name: /^动作库/ }))
    expect(within(screen.getByRole('complementary', { name: '动作库' })).getByText('宏1')).toBeTruthy()
  })
})

describe('App: what the page knows about the keyboard (review regressions)', () => {
  const connected = () => within(bar()).findByRole('button', { name: /^已连接/ })
  const A = keyById('a')!.no - 1
  const Q = keyById('q')!.no - 1

  it('a reconnect keeps a doubted M light, and the next write reads the keyboard first', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'office', program: customBank() })
    const { plug } = setupHid(kb)
    await connected()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('读到的是出厂键位')
    mapCapsToEscape()
    plug('disconnect')
    await screen.findByText('键盘已断开')
    plug('connect')
    await connected()
    expect(within(bar()).getByRole('button', { name: /读到出厂键位 · M 灯亮着吗/ })).toBeTruthy()

    const seen = spyCommands(kb)
    fireEvent.click(tool(/写入键盘/))
    const dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    expect(await within(dialog).findByRole('button', { name: /仍然写入/ })).toBeTruthy()
    expect(seen).toContain(0xf2)
    expect(seen).not.toContain(0xf1)
  })

  it('a real keyboard after the simulator is read and backed up before the first write', async () => {
    const real = new SimulatedKeyboard({ latencyMs: 0, mode: 'program', program: customBank() })
    const { store } = setupHid(real, { granted: false, simulator: new SimulatedKeyboard({ latencyMs: 0 }) })
    await connectSim()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('已读取键盘')
    mapCapsToEscape()
    await writeAndConfirm()
    await screen.findByText('写入成功，已校验')
    fireEvent.click(screen.getByRole('button', { name: '好的' }))
    expect(within(sync()).getByText('已写入并校验')).toBeTruthy()

    fireEvent.click(within(bar()).getByRole('button', { name: /^已连接/ }))
    fireEvent.click(screen.getByRole('button', { name: /断开/ }))
    fireEvent.click(await within(bar()).findByRole('button', { name: '连接键盘' }))
    await connected()
    // Nothing is known about this keyboard; the edit stays on the page.
    expect(within(sync()).getByText('页面上有 1 处修改 · 写入前会先读取键盘')).toBeTruthy()
    fireEvent.click(tool(/写入键盘/))
    const dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    // read first: its A → B goes too, and the dialog says so
    expect(await within(dialog).findByText(/有 2 个键位会改变/)).toBeTruthy()
    expect(within(dialog).getByText('基础层 · A')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: /确认写入/ }))
    await screen.findByText('写入成功，已校验')
    const backups = (await (await store).listBackups()).filter((b) => b.target === 'keyboard')
    expect(backups).toHaveLength(1)
    const restored = await (await store).restoreBackup(backups[0].id)
    expect(profileToTable(restored.profile!).base[A]).toEqual(customBank().base[A])
  })

  it('an incomplete read is not taken as the keyboard: nothing turns into 无, and the next write reads first', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'program', program: customBank() })
    setupHid(kb)
    await connected()
    const restore = dropReadSlot(kb, 'a')
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('读取不完整：有 1 个键位没有收到')
    restore()
    expect(faceOf('A')).toMatch(/^A：A/)
    expect(within(sync()).getByText('键盘状态未知 · 建议重新读取')).toBeTruthy()
    // Nothing was written: the pill does not blame a broken write.
    expect(within(sync()).getByRole('button').title).not.toMatch(/只写了一部分/)

    mapCapsToEscape()
    const seen = spyCommands(kb)
    fireEvent.click(tool(/写入键盘/))
    const dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    // A, which that read missed, is listed: writing it is no longer silent
    expect(await within(dialog).findByText('基础层 · A')).toBeTruthy()
    expect(seen).toContain(0xf2)
    expect(seen).not.toContain(0xf1)
  })

  it('an incomplete read in Office mode keeps the known custom page', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'program', program: customBank() })
    setupHid(kb)
    await connected()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('已读取键盘')
    kb.setMode('office')
    dropReadSlot(kb, 'q')
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('页面上的键位保持不变')
    expect(screen.getByText(/这次还有 1 个键位没有收到/)).toBeTruthy()
    expect(faceOf('A')).toMatch(/^A：B/)
    expect(faceOf('Q')).toMatch(/^Q：Q/)
    expect(within(bar()).getByRole('button', { name: /办公模式 · M 灯灭/ })).toBeTruthy()
  })

  it('ticking 亮着 before the first read does not silence the doubt about a factory read', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'office', program: customBank() })
    setupHid(kb)
    await connected()
    fireEvent.click(screen.getByRole('button', { name: 'M 灯亮着' }))
    expect(screen.getByText('确认 F12 上的 M 灯亮着').closest('li')!.className).toBe('is-done')
    expect(within(bar()).getByRole('button', { name: /M 灯 · 读取前请确认亮着/ })).toBeTruthy()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('读到的是出厂键位')
    mapCapsToEscape()
    fireEvent.click(tool(/写入键盘/))
    expect(await screen.findByRole('button', { name: /仍然写入/ })).toBeTruthy()
  })

  it('确实是出厂键位，载入 takes a factory read after 键盘复位', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'program', program: customBank() })
    setupHid(kb)
    await connected()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('已读取键盘')
    // 键盘复位: the custom bank is the factory map again; the M light stays on.
    encodeWriteSequence(FACTORY).forEach((p) => kb.handle(p))
    fireEvent.click(tool(/^读取键盘/))
    let notice = (await screen.findByText('页面上的键位保持不变')).closest('.notice') as HTMLElement
    // Step ②'s 亮着 does not pretend to answer this; the chip's 重新读取 brings the way out back after × .
    expect(screen.queryByRole('button', { name: 'M 灯亮着' })).toBeNull()
    fireEvent.click(within(notice).getByRole('button', { name: '关闭提示' }))
    fireEvent.click(within(bar()).getByRole('button', { name: /办公模式 · M 灯灭/ }))
    fireEvent.click(screen.getByRole('button', { name: /重新读取/ }))
    notice = (await screen.findByText('页面上的键位保持不变')).closest('.notice') as HTMLElement
    fireEvent.click(within(notice).getByRole('button', { name: '确实是出厂键位，载入' }))
    await screen.findByText('键盘里的键位就是出厂键位，已载入到页面。')
    expect(faceOf('A')).toMatch(/^A：A/)
    expect(within(bar()).getByRole('button', { name: /编程模式 · M 灯亮/ })).toBeTruthy()
    expect(within(sync()).getByText('与键盘一致')).toBeTruthy()
    // From now on a factory read is just that.
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('键盘里的键位就是出厂键位。')
    expect(screen.queryByText('页面上的键位保持不变')).toBeNull()
  })

  it('a failed 先重新读取键盘 says so', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'office', program: customBank() })
    setupHid(kb, { session: { firstTimeoutMs: 20 } })
    await connected()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('读到的是出厂键位')
    mapCapsToEscape()
    fireEvent.click(tool(/写入键盘/))
    const reread = await screen.findByRole('button', { name: /先重新读取键盘/ })
    kb.muted = true
    fireEvent.click(reread)
    expect(await screen.findByText(/^重新读取失败：和键盘通信出错/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /仍然写入/ })).toBeTruthy()
  })

  it('an Office-mode read before writing, after a broken write, compares with the keys the page knows', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'program', program: customBank() })
    setupHid(kb, { session: { firstTimeoutMs: 20 } })
    await connected()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('已读取键盘')
    mapCapsToEscape()
    kb.muted = true
    await writeAndConfirm()
    await screen.findByText('写入中断')
    fireEvent.click(within(screen.getByRole('dialog', { name: '写入结果' })).getAllByRole('button', { name: '关闭' })[0])

    kb.muted = false
    kb.setMode('office')
    fireEvent.click(tool(/写入键盘/))
    const dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    await within(dialog).findByRole('button', { name: /仍然写入/ })
    expect(within(dialog).queryByText(/还没有读取键盘/)).toBeNull()
    expect(within(dialog).getByText(/键盘现在多半是办公模式/)).toBeTruthy()
    expect(within(dialog).getByText(/有 1 个键位会改变/)).toBeTruthy()
  })

  it('unplugging closes the write confirmation, and says nothing was written', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'program', program: customBank() })
    const { plug } = setupHid(kb)
    await connected()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('已读取键盘')
    mapCapsToEscape()
    fireEvent.click(tool(/写入键盘/))
    await screen.findByRole('button', { name: /确认写入/ })
    plug('disconnect')
    await screen.findByText('键盘已断开，没有写入')
    expect(screen.queryByRole('dialog', { name: '写入键盘' })).toBeNull()
    expect(kb.getBank('program').base[CAPS]).toEqual(FACTORY.base[CAPS])
  })

  it('a write whose keyboard went away before the first packet says nothing reached it', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'program', program: customBank() })
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const base = await openLocalStore({ backend: memoryBackend() })
    const store: LocalStore = {
      ...base,
      addBackup: async (profile, note, target) => {
        await gate
        return base.addBackup(profile, note, target)
      },
    }
    const { plug } = setupHid(kb, { store })
    await connected()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('已读取键盘')
    mapCapsToEscape()
    await writeAndConfirm()
    await screen.findByRole('dialog', { name: '正在写入键盘' })
    plug('disconnect')
    release()
    const result = await screen.findByRole('dialog', { name: '写入结果' })
    expect(await within(result).findByText(/键盘没有收到任何改动/)).toBeTruthy()
    expect(kb.getBank('program').base[CAPS]).toEqual(FACTORY.base[CAPS])
    fireEvent.click(within(result).getAllByRole('button', { name: '关闭' })[0])
    plug('connect')
    await connected()
    expect(within(sync()).queryByText(/键盘状态未知/)).toBeNull()
  })

  it('再写一次 after a failed 重新校验 does not write later edits unseen', async () => {
    const kb = setup('office')
    await connectAndRead()
    await screen.findByText('读到的是出厂键位')
    mapCapsToEscape()
    await writeAndConfirm()
    await screen.findByText('已写入，还没生效')
    fireEvent.click(screen.getByRole('button', { name: '稍后' }))
    mapKey('Q', 'Escape')

    kb.setMode('program')
    const restore = dropReadSlot(kb, 'a')
    fireEvent.click(within(bar()).getByRole('button', { name: '两种模式的说明' }))
    fireEvent.click(await screen.findByRole('button', { name: /M 灯已亮，重新校验/ }))
    const result = await screen.findByRole('dialog', { name: '写入结果' })
    await within(result).findByText('校验未通过')
    restore()
    fireEvent.click(within(result).getByRole('button', { name: /再写一次/ }))
    // The page changed since that write: it goes through the confirmation, which lists Q.
    const dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    expect(await within(dialog).findByText('基础层 · Q')).toBeTruthy()
    expect(kb.getBank('program').base[Q]).toEqual(FACTORY.base[Q])
  })

  it('重试 that connects clears the 键盘已断开 notice', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0 })
    const { plug, failOpens } = setupHid(kb)
    await connected()
    plug('disconnect')
    await screen.findByText('键盘已断开')
    failOpens(1)
    plug('connect')
    fireEvent.click(await within(bar()).findByRole('button', { name: '重试' }))
    await connected()
    expect(screen.queryByText('键盘已断开')).toBeNull()
  })

  it('断开 and 连接键盘 after a waved-through factory read still reads before writing and warns', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'office', program: customBank() })
    setupHid(kb)
    await connected()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('读到的是出厂键位')
    // The user says the light is on (it is not), then reconnects by hand.
    fireEvent.click(screen.getByRole('button', { name: 'M 灯亮着，继续' }))
    mapCapsToEscape()
    fireEvent.click(within(bar()).getByRole('button', { name: /^已连接/ }))
    fireEvent.click(screen.getByRole('button', { name: /断开/ }))
    fireEvent.click(await within(bar()).findByRole('button', { name: '连接键盘' }))
    await connected()

    const seen = spyCommands(kb)
    fireEvent.click(tool(/写入键盘/))
    const dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    expect(await within(dialog).findByRole('button', { name: /仍然写入/ })).toBeTruthy()
    expect(within(dialog).getByText(/还不确定当时 M 灯是否亮着/)).toBeTruthy()
    expect(seen).toContain(0xf2)
    expect(seen).not.toContain(0xf1)
  })

  it('a custom write to the simulator does not make a factory keyboard read as Office mode', async () => {
    const real = new SimulatedKeyboard({ latencyMs: 0, mode: 'program' })
    setupHid(real, { granted: false, simulator: new SimulatedKeyboard({ latencyMs: 0 }) })
    await connectSim()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('已读取键盘')
    mapCapsToEscape()
    await writeAndConfirm()
    await screen.findByText('写入成功，已校验')
    fireEvent.click(screen.getByRole('button', { name: '好的' }))

    fireEvent.click(within(bar()).getByRole('button', { name: /^已连接/ }))
    fireEvent.click(screen.getByRole('button', { name: /断开/ }))
    fireEvent.click(await within(bar()).findByRole('button', { name: '连接键盘' }))
    await connected()
    expect(within(sync()).queryByText('已写入并校验')).toBeNull()
    fireEvent.click(tool(/^读取键盘/))
    fireEvent.click(await screen.findByRole('button', { name: '读取并替换' }))
    // Nothing is known about this keyboard: a factory read is doubted, not taken as Office mode.
    await screen.findByText('读到的是出厂键位')
    expect(screen.queryByText('页面上的键位保持不变')).toBeNull()
    expect(within(bar()).getByRole('button', { name: /读到出厂键位 · M 灯亮着吗/ })).toBeTruthy()
    expect(faceOf('Caps Lock')).toMatch(/^Caps Lock：Caps/)
  })

  it('an incomplete read-back after a write leaves the keyboard unknown; the next write reads first and backs up what is on it', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'program', program: customBank() })
    const { store } = setupHid(kb)
    await connected()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('已读取键盘')
    mapCapsToEscape()
    const restoreWrites = dropWrites(kb)
    const restoreRead = dropReadSlot(kb, 'q')
    await writeAndConfirm()
    const result = await screen.findByRole('dialog', { name: '写入结果' })
    await within(result).findByText('校验未通过')
    restoreWrites()
    restoreRead()
    fireEvent.click(within(result).getAllByRole('button', { name: '关闭' })[0])
    expect(within(sync()).getByText('键盘状态未知 · 建议重新读取')).toBeTruthy()

    const seen = spyCommands(kb)
    fireEvent.click(tool(/写入键盘/))
    const dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    expect(await within(dialog).findByText(/有 1 个键位会改变/)).toBeTruthy()
    expect(seen).toContain(0xf2)
    expect(seen).not.toContain(0xf1)
    fireEvent.click(within(dialog).getByRole('button', { name: /确认写入/ }))
    await screen.findByText('写入成功，已校验')
    expect(kb.getBank('program').base[A]).toEqual(customBank().base[A])
    expect(kb.getBank('program').base[Q]).toEqual(FACTORY.base[Q])
    // The second backup is the first one again (an identical one is not added): the keyboard's A → B, no hole.
    const backups = (await (await store).listBackups()).filter((b) => b.target === 'keyboard')
    expect(backups).toHaveLength(1)
    const restored = await (await store).restoreBackup(backups[0].id)
    expect(diffTables(profileToTable(restored.profile!), customBank())).toEqual([])
  })

  it('a dropped packet from a factory keyboard does not make the next complete read look like Office mode', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'program' })
    setupHid(kb)
    await connected()
    const restore = dropReadSlot(kb, 'caps')
    fireEvent.click(tool(/^读取键盘/))
    const notice = (await screen.findByText('读取不完整：有 1 个键位没有收到')).closest('.notice') as HTMLElement
    restore()
    expect(faceOf('Caps Lock')).toMatch(/^Caps Lock：Caps/)
    fireEvent.click(within(notice).getByRole('button', { name: '重新读取' }))
    await screen.findByText('读到的是出厂键位')
    expect(screen.queryByText('页面上的键位保持不变')).toBeNull()
    expect(within(bar()).queryByRole('button', { name: /办公模式 · M 灯灭/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'M 灯亮着，继续' }))
    expect(within(bar()).getByRole('button', { name: /编程模式 · M 灯亮/ })).toBeTruthy()
    expect(within(sync()).getByText('与键盘一致')).toBeTruthy()
    expect(faceOf('Caps Lock')).toMatch(/^Caps Lock：Caps/)
  })

  it('writing in Office mode after a custom read says what is known, and the backup holds the custom keys', async () => {
    const kb = new SimulatedKeyboard({ latencyMs: 0, mode: 'program', program: customBank() })
    const { store } = setupHid(kb)
    await connected()
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('已读取键盘')
    kb.setMode('office')
    fireEvent.click(tool(/^读取键盘/))
    await screen.findByText('页面上的键位保持不变')
    // Office mode was read, not guessed: step ② does not offer 亮着.
    expect(screen.queryByRole('button', { name: 'M 灯亮着' })).toBeNull()
    mapCapsToEscape()

    fireEvent.click(tool(/写入键盘/))
    let dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    expect(within(dialog).getByText(/刚才读到的是出厂键位，但键盘里存着你改过的键位/)).toBeTruthy()
    expect(dialog.textContent).not.toMatch(/还不确定|自动备份里也只有出厂键位/)
    fireEvent.click(within(dialog).getByRole('button', { name: /仍然写入/ }))
    await screen.findByText('已写入，还没生效')
    const backups = (await (await store).listBackups()).filter((b) => b.target === 'keyboard')
    expect(backups).toHaveLength(1)
    const restored = await (await store).restoreBackup(backups[0].id)
    expect(diffTables(profileToTable(restored.profile!), customBank())).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: '稍后' }))
    // 重新校验 is pending: step ② still does not offer 亮着.
    expect(screen.queryByRole('button', { name: 'M 灯亮着' })).toBeNull()
    fireEvent.click(tool(/写入键盘/))
    dialog = await screen.findByRole('dialog', { name: '写入键盘' })
    expect(within(dialog).getByText(/键盘里存着你改过的键位/)).toBeTruthy()
    expect(dialog.textContent).not.toMatch(/还不确定|自动备份里也只有出厂键位/)
  })
})

describe('App: notices, focus and layout (review regressions)', () => {
  it('a warning left from an undone change does not offer 撤销 again after a new edit', async () => {
    setup()
    bulkMenu(/全部清空/)
    const clear = await screen.findByRole('dialog', { name: '全部清空' })
    fireEvent.click(within(clear).getByRole('checkbox', { name: '连 Fn 和模式切换也清空' }))
    fireEvent.click(within(clear).getByRole('button', { name: /全部清空（含 Fn）/ }))
    const notice = (await screen.findByText('已清空全部键位（包括 Fn 和模式切换）')).closest('.notice') as HTMLElement
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    await waitFor(() => expect(faceOf('Fn')).toMatch(/^Fn：Fn/))
    mapCapsToEscape()
    expect(within(notice).queryByRole('button', { name: '撤销' })).toBeNull()
    expect(faceOf('Caps Lock')).toMatch(/^Caps Lock：Esc/)
  })

  it('asks before leaving with a 动作库 that was never kept', async () => {
    setup()
    const leave = () => {
      const e = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(e)
      return e.defaultPrevented
    }
    fireEvent.click(keyButton('Caps Lock'))
    const inspector = screen.getByRole('complementary', { name: '键位设置' })
    fireEvent.click(within(inspector).getByRole('radio', { name: '宏' }))
    fireEvent.click(within(inspector).getByRole('button', { name: /存入动作库/ }))
    fireEvent.click(within(inspector).getByRole('button', { name: '改回出厂' }))
    expect(faceOf('Caps Lock')).toMatch(/^Caps Lock：Caps/)
    expect(leave()).toBe(true)
    const download = captureDownload()
    planMenu(/导出 JSON（完整）/)
    await download
    expect(leave()).toBe(false)
  })

  it('撤销 on the last notice leaves focus on the toolbar, not on <body>', async () => {
    setup()
    mapCapsToEscape()
    bulkMenu(/全部改回出厂键位/)
    const notice = (await screen.findByText('已把全部键位改回出厂键位')).closest('.notice') as HTMLElement
    const undo = within(notice).getByRole('button', { name: '撤销' })
    undo.focus()
    fireEvent.click(undo)
    expect(faceOf('Caps Lock')).toMatch(/^Caps Lock：Esc/)
    expect(screen.getByRole('navigation', { name: '主要操作' }).contains(document.activeElement)).toBe(true)
  })

  it('the checklist hands focus on to the next step as each one is done', async () => {
    setup()
    const list = () => screen.getByRole('heading', { name: '从这里开始' }).parentElement as HTMLElement
    const sim = within(list()).getByRole('button', { name: '使用模拟键盘' })
    sim.focus()
    fireEvent.click(sim)
    await within(bar()).findByRole('button', { name: /^已连接/ })
    const read = await within(list()).findByRole('button', { name: /读取键盘/ })
    await waitFor(() => expect(document.activeElement).toBe(read))
    fireEvent.click(read)
    await screen.findByText('已读取键盘')
    await waitFor(() => expect(document.activeElement?.textContent).toMatch(/^在键盘图上点一个键/))
  })

  it('step ⑤ reads as one sentence, and its link focuses the key tester', async () => {
    setup()
    await connectAndRead()
    await screen.findByText('已读取键盘')
    mapCapsToEscape()
    await writeAndConfirm()
    await screen.findByText('写入成功，已校验')
    fireEvent.click(screen.getByRole('button', { name: '好的' }))
    fireEvent.click(keyButton('Caps Lock'))
    const link = screen.getByRole('button', { name: '打开按键测试' })
    expect(link.closest('.step-sub')?.textContent).toBe('已写入。直接按键试试，或打开按键测试。')
    link.focus()
    fireEvent.click(link)
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: '按键测试' }))
  })

  it('a row of the 未写入 list shows its key settings, also from the key tester', async () => {
    setup()
    await connectAndRead()
    await screen.findByText('已读取键盘')
    mapCapsToEscape()
    fireEvent.click(screen.getByRole('radio', { name: '按键测试' }))
    fireEvent.click(within(sync()).getByRole('button', { name: /1 处修改未写入/ }))
    fireEvent.click(within(screen.getByRole('menu', { name: '未写入的修改' })).getByRole('menuitem', { name: /基础层 · Caps Lock/ }))
    expect(screen.getByRole('complementary', { name: '键位设置' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Caps Lock' })).toBeTruthy()
  })

  it('a macro recording started from the keyboard stops with Esc Esc, and its keys are no shortcuts', () => {
    setup()
    fireEvent.click(keyButton('Caps Lock'))
    const inspector = screen.getByRole('complementary', { name: '键位设置' })
    fireEvent.click(within(inspector).getByRole('radio', { name: '宏' }))
    const rec = within(inspector).getByRole('button', { name: /录制/ })
    rec.focus()
    fireEvent.click(rec)
    expect(rec.getAttribute('aria-pressed')).toBe('true')
    for (const [code, key] of [['KeyA', 'a'], ['Digit2', '2'], ['Escape', 'Escape'], ['Escape', 'Escape']]) {
      fireEvent.keyDown(document.activeElement!, { code, key })
      fireEvent.keyUp(document.activeElement!, { code, key })
    }
    expect(rec.getAttribute('aria-pressed')).toBe('false')
    expect(document.activeElement).toBe(rec)
    expect(rec.textContent).toBe('重新录制（替换 2 步）')
    // Neither Esc deselected the key, and 2 was recorded, not taken as the layer shortcut.
    expect(screen.getByRole('heading', { name: 'Caps Lock' })).toBeTruthy()
    expect(screen.getByRole('group', { name: /基础层/ })).toBeTruthy()
  })

  it('1 / 2 keep focus in the inspector, and do nothing inside a menu', () => {
    setup()
    fireEvent.click(keyButton('Caps Lock'))
    const type = within(screen.getByRole('complementary', { name: '键位设置' })).getByRole('radio', { name: '按键' })
    type.focus()
    fireEvent.keyDown(type, { key: '2' })
    expect(screen.getByRole('group', { name: /Fn 层/ })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /^Fn 层：/ }))

    fireEvent.click(screen.getByRole('button', { name: '方案' }))
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: '1' })
    expect(screen.getByRole('group', { name: /Fn 层/ })).toBeTruthy()
  })

  it('on a narrow window a picked key scrolls its settings to just below the sticky toolbar', () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true }) })
    try {
      const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 500 } as DOMRect)
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('toolbar') ? 60 : 0
      })
      setup()
      fireEvent.click(keyButton('Q'))
      expect(scrollTo).toHaveBeenCalledWith({ top: 500 - 60 - 8, behavior: 'smooth' })
    } finally {
      delete (window as { matchMedia?: unknown }).matchMedia
    }
  })
})
