/**
 * Cross-module checks: the .pro layer, the Plum format layer and the wire codec must agree on every action kind,
 * using the real files and the live capture as the reference (docs/re/).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FACTORY, KEYS, keyById } from './device/layout'
import { normalizeProfile, parseProfileJson, profileToTable, serializeProfile, tableToProfile } from './format'
import { parseProFile, toProFile } from './kb84/pro'
import { diffTables, encodeWriteSequence } from './protocol/codec'
import { KeyboardSession } from './protocol/session'
import { SimulatedKeyboard, SimulatorTransport } from './transport/simulator'

const DOCS = new URL('../../docs/re/', import.meta.url)
const readDoc = (path: string) => readFileSync(new URL(path, DOCS), 'utf8')
const toBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16))
const hex = (p: Uint8Array) => Array.from(p, (b) => b.toString(16).padStart(2, '0')).join('')

/** The complete KB84 write sequence (F1 … F6) captured after a step marker, as 64-byte payloads. */
function capturedWrite(step: string): Uint8Array[] {
  let current = ''
  let seq: Uint8Array[] | null = null
  for (const line of readDoc('live-capture.jsonl').split(/\r?\n/)) {
    if (!line) continue
    const e = JSON.parse(line) as { kind: string; data?: string; text?: string }
    if (e.kind === 'marker') current = e.text!.split(' ')[0]
    if (current !== step || e.kind !== 'W' || !e.data) continue
    const p = toBytes(e.data).subarray(1)
    if (p[1] === 0xf1) seq = [p]
    else if (seq) {
      seq.push(p)
      if (p[1] === 0xf6) return seq
    }
  }
  throw new Error(`no complete write after ${step}`)
}

function importPro(name: string) {
  const { profile, issues } = parseProFile(readDoc(`samples/${name}`))
  expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  return profile!
}

const slotPackets = (seq: Uint8Array[], layer: number, keyNo: number) =>
  seq.filter((p) => p[1] === 0xf0 && p[2] === layer && p[3] === keyNo).map(hex)

describe('.pro -> profile -> slots -> packets agrees with the live capture', () => {
  it('KEYS are in key-number order (slot index i = key no i+1)', () => {
    expect(KEYS.map((k) => k.no)).toEqual(Array.from({ length: 84 }, (_, i) => i + 1))
  })

  it('test.pro compiles to the exact STEP2 write, Fn H/J/K/L/N included', () => {
    const seq = encodeWriteSequence(profileToTable(importPro('test.pro')))
    const captured = capturedWrite('STEP2')
    // combo, fixed-interval macro, recorded macro (hold), emulate, mouse key
    for (const id of ['h', 'j', 'k', 'l', 'n']) {
      const no = keyById(id)!.no
      const want = slotPackets(captured, 2, no)
      expect(want.length, `Fn+${id} captured`).toBeGreaterThan(0)
      expect(slotPackets(seq, 2, no), `Fn+${id}`).toEqual(want)
    }
    expect(seq.map(hex)).toEqual(captured.map(hex))
  })

  it('config.pro equals FACTORY and compiles to the STEP5 restore write', () => {
    const table = profileToTable(importPro('config.pro'))
    expect(table).toEqual(FACTORY)
    expect(encodeWriteSequence(table).map(hex)).toEqual(capturedWrite('STEP5').map(hex))
  })

  it.each(['config.pro', 'test.pro'])('%s survives .pro -> JSON -> .pro and JSON -> table unchanged', (name) => {
    const text = readDoc(`samples/${name}`)
    const profile = importPro(name)
    const json = parseProfileJson(serializeProfile(profile))
    expect(json.issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(profileToTable(json.profile!)).toEqual(profileToTable(profile))
    expect(toProFile(json.profile!)).toBe(text.replace(/\r?\n/g, '\r\n'))
  })

  it('my_customer_mapping.pro imports as a valid profile that encodes', () => {
    const profile = importPro('my_customer_mapping.pro')
    expect(normalizeProfile(profile).issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(() => encodeWriteSequence(profileToTable(profile))).not.toThrow()
  })
})

describe('session + simulator end to end', () => {
  const session = (kb: SimulatedKeyboard) =>
    new KeyboardSession(new SimulatorTransport(kb), { postWriteDelayMs: 0, sleep: async () => {} })

  it('writes test.pro in Program mode and reads it back to the same profile', async () => {
    const kb = new SimulatedKeyboard()
    const s = session(kb)
    const table = profileToTable(importPro('test.pro'))
    const res = await s.writeAll(table)
    expect(res).toMatchObject({ verified: true, likelyOfficeMode: false })
    const read = await s.readAll()
    expect(read.warnings).toEqual([])
    expect(diffTables(read.table, table)).toEqual([])
    expect(toProFile(tableToProfile(read.table))).toContain('<KEY ID="55" Level="1" Mode="3"')
  })

  it('an Office-mode write lands in the custom bank and is flagged as likely Office mode', async () => {
    const kb = new SimulatedKeyboard({ mode: 'office' })
    const s = session(kb)
    const table = profileToTable(importPro('test.pro'))
    const res = await s.writeAll(table)
    expect(res).toMatchObject({ verified: false, likelyOfficeMode: true })
    expect(res.readBack?.matchesFactory).toBe(true)
    expect(diffTables(kb.getBank('program'), table)).toEqual([])
    kb.setMode('program')
    expect(diffTables((await s.readAll()).table, table)).toEqual([])
  })
})
