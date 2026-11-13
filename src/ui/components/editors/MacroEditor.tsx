import { useEffect, useRef, useState } from 'react'
import { codeForKeyboardEventCode, codeShort } from '../../../device/codes'
import { MACRO_MAX_DATA_BYTES, macroDataLength } from '../../../format/compile'
import type { Action, CodeRef, MacroPlay, MacroStep } from '../../../format/types'
import { MACRO_CHUNK_SIZE } from '../../../protocol/codec'
import { codeZh, macroDurationMs, macroEventCount, macroPreview, PLAY_ZH, stepCode } from '../../lib/describe'
import { recordedSteps, stepTimingProblem, toFixedTiming, toStepTiming, type RecordedEvent } from '../../lib/macro'
import { useKeyCapture } from '../../lib/useKeyCapture'
import { CodePicker } from '../CodePicker'
import { Icon } from '../Icon'
import { NumberField } from '../NumberField'
import { Segmented } from '../Segmented'
import './editors.css'

type Macro = Extract<Action, { type: 'macro' }>
type KeyKind = 'tap' | 'down' | 'up'
type Timing = 'fixed' | 'recorded'
type Change = (a: Action, coalesce?: string) => void

/** Largest macro the live capture verified on the real keyboard (3 packets). */
const VERIFIED_BYTES = 157
const MAX_WAIT = 65535
const MAX_INTERVAL = 60000
const DEFAULT_INTERVAL = 30
const DEFAULT_WAIT = 100
/** Two plain Esc presses this close together stop recording, as in the key tester (one Esc is recorded like any key). */
const ESC_STOP_MS = 800

const KIND_ZH: Record<KeyKind, string> = { tap: '单击', down: '按下', up: '松开' }

const PLAY_HINT: Record<Exclude<MacroPlay, 'repeat'>, string> = {
  hold: '按住时播放，松开就停止。写入后请实际试一试。',
  toggle: '按一下开始播放，再按一下停止。写入后请实际试一试。',
}

function kindOf(s: MacroStep): KeyKind | 'wait' {
  return 'wait' in s ? 'wait' : 'tap' in s ? 'tap' : 'down' in s ? 'down' : 'up'
}

/** 150 ms → "0.2" (rounded half up; toFixed alone would print "0.1"). */
const seconds = (ms: number) => (Math.round(ms / 100) / 10).toFixed(1)

const makeStep = (kind: KeyKind, ref: CodeRef): MacroStep =>
  kind === 'tap' ? { tap: ref } : kind === 'down' ? { down: ref } : { up: ref }

/** The experimental play modes carry a pill in their segment. */
const experimental = (play: MacroPlay) => (
  <>
    {PLAY_ZH[play]}
    <span className="pill-exp">实验性</span>
  </>
)

type PickerState = { mode: 'add'; kind: KeyKind } | { mode: 'edit'; index: number } | null

/** Under 按键之间: why a switch to 逐步设置 was refused, or what a switch did; shown while the steps are still `steps`. */
type TimingNote = { warn: boolean; text: string; steps: readonly MacroStep[] } | null

interface Props {
  action: Macro
  onChange: Change
  /** Issue messages per step index (already translated). */
  stepIssues: Map<number, string[]>
}

export function MacroEditor({ action, onChange, stepIssues }: Props) {
  const [pickerState, setPicker] = useState<PickerState>(null)
  // An edited step may have been removed (undo, delete) while the picker was open.
  const editedStep = pickerState?.mode === 'edit' ? action.steps[pickerState.index] : undefined
  const picker = pickerState?.mode === 'edit' && (!editedStep || 'wait' in editedStep) ? null : pickerState
  // Recorded events live in a ref (several key events can arrive before a re-render); `rec` mirrors it for display.
  const [rec, setRecState] = useState<RecordedEvent[] | null>(null)
  const recRef = useRef<RecordedEvent[] | null>(null)
  const setRec = (next: RecordedEvent[] | null) => {
    recRef.current = next
    setRecState(next)
  }
  const held = useRef(new Set<string>())
  const fixed = action.interval !== undefined
  const setSteps = (steps: MacroStep[], coalesce?: string) => onChange({ ...action, steps }, coalesce)

  // 逐步设置 → 统一间隔 drops the waits, so it asks first; `confirmInterval` is the interval it would set.
  const [confirmInterval, setConfirmInterval] = useState<number | null>(null)
  const [timingNote, setTimingNote] = useState<TimingNote>(null)
  const timingBox = useRef<HTMLDivElement>(null)
  /** Set when the confirm closes: focus goes back to the checked 按键之间 option once it is gone. */
  const refocusTiming = useRef(false)
  useEffect(() => {
    if (confirmInterval === null && refocusTiming.current) {
      refocusTiming.current = false
      timingBox.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    }
  }, [confirmInterval])

  const events = macroEventCount(action.steps)
  const bytes = macroDataLength(events, !fixed)
  const packets = Math.max(1, Math.ceil(bytes / MACRO_CHUNK_SIZE))
  const used = bytes === 0 ? 0 : Math.max(1, Math.round((bytes / MACRO_MAX_DATA_BYTES) * 100))
  const waits = action.steps.filter((s) => 'wait' in s).length

  const stopRecording = (list: RecordedEvent[] | null = recRef.current) => {
    if (!list) return
    const t = performance.now()
    const closing = [...held.current].map((ref): RecordedEvent => ({ ref, dir: 'up', t }))
    held.current.clear()
    setRec(null)
    if (list.length) setSteps(recordedSteps([...list, ...closing], !fixed))
  }

  useKeyCapture(rec !== null, {
    onDown: (e) => {
      const info = codeForKeyboardEventCode(e.code)
      const rec = recRef.current
      if (e.repeat || !info || held.current.has(info.id) || !rec) return
      const t = performance.now()
      // Every key is recorded, Tab and Enter on this button too, so the keyboard way out is two plain Esc presses in a
      // row: the second one stops, and the first one (the last down and up) is dropped again.
      const [down, up] = rec.slice(-2)
      const secondEsc = e.code === 'Escape' && up?.ref === info.id && up.dir === 'up' && t - down.t < ESC_STOP_MS
      if (secondEsc && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return stopRecording(rec.slice(0, -2))
      const next = [...rec, { ref: info.id, dir: 'down' as const, t }]
      // Stop before the macro outgrows what the keyboard accepts (counting the releases of every held key); this
      // press is dropped, so it must not get a closing release either.
      if (macroDataLength(next.length + held.current.size + 1, !fixed) > MACRO_MAX_DATA_BYTES) return stopRecording(rec)
      held.current.add(info.id)
      setRec(next)
    },
    onUp: (e) => {
      const info = codeForKeyboardEventCode(e.code)
      const rec = recRef.current
      if (!info || !held.current.has(info.id) || !rec) return
      held.current.delete(info.id)
      setRec([...rec, { ref: info.id, dir: 'up', t: performance.now() }])
    },
    onBlur: () => stopRecording(),
  })

  const setPlay = (play: MacroPlay) => {
    const { repeat: _r, ...rest } = action
    onChange(play === 'repeat' ? { ...rest, play, repeat: 1 } : { ...rest, play })
  }
  /** 统一间隔 → 逐步设置 with the same playback (then `extra` appended); refused with a note when it cannot fit. */
  const toSteps = (extra: MacroStep[] = []) => {
    const problem = stepTimingProblem(action.steps)
    if (problem) return setTimingNote({ warn: true, text: problem, steps: action.steps })
    const { interval = 0, ...rest } = action
    const steps = [...toStepTiming(action.steps, interval), ...extra]
    onChange({ ...rest, steps })
    if (interval > 0 && events > 1) setTimingNote({ warn: false, text: `已改为逐步设置：原来的统一间隔 ${interval} ms 写成了“等待”步骤，播放效果不变。`, steps })
  }
  const toFixed = (interval: number) => onChange({ ...action, interval, steps: toFixedTiming(action.steps) })
  const setTiming = (t: Timing) => {
    setTimingNote(null)
    if (t === 'recorded') {
      setConfirmInterval(null)
      toSteps()
    } else if (waits) setConfirmInterval((v) => v ?? DEFAULT_INTERVAL)
    else toFixed(DEFAULT_INTERVAL)
  }
  const closeConfirm = (apply: boolean) => {
    if (apply && confirmInterval !== null) toFixed(confirmInterval)
    refocusTiming.current = true
    setConfirmInterval(null)
  }
  const addWait = () => {
    if (fixed) toSteps([{ wait: DEFAULT_WAIT }])
    else setSteps([...action.steps, { wait: DEFAULT_WAIT }])
  }
  const move = (i: number, d: -1 | 1) => {
    const steps = [...action.steps]
    ;[steps[i], steps[i + d]] = [steps[i + d], steps[i]]
    setSteps(steps)
  }
  const pick = (ref: CodeRef) => {
    if (!picker) return
    if (picker.mode === 'add') setSteps([...action.steps, makeStep(picker.kind, ref)])
    else {
      const kind = editedStep && kindOf(editedStep)
      if (kind && kind !== 'wait') setSteps(action.steps.map((x, j) => (j === picker.index ? makeStep(kind, ref) : x)))
      setPicker(null)
    }
  }

  return (
    <div className="editor macro">
      <div className="macro-head">
        <span className="field-label">步骤（{action.steps.length}）</span>
        <div className="row-actions">
          <button
            type="button"
            className={`btn btn-sm btn-rec${rec ? ' is-live' : ''}`}
            onClick={() => {
              if (rec) stopRecording()
              else {
                held.current.clear()
                setPicker(null)
                setRec([])
              }
            }}
            aria-pressed={rec !== null}
          >
            <span className="rec-dot" aria-hidden="true" />
            {rec ? '停止录制（或连按两次 Esc）' : action.steps.length ? `重新录制（替换 ${action.steps.length} 步）` : '录制'}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={!action.steps.length || rec !== null} onClick={() => setSteps([])}>
            <Icon name="trash" size={14} />
            清空
          </button>
        </div>
      </div>

      {action.steps.length > 0 && (
        <p className="macro-preview">
          效果：{macroPreview(action, 8) || '没有按键'} · 播放一遍约 {seconds(macroDurationMs(action))} 秒
        </p>
      )}

      {rec && (
        <div className="rec-live" role="status">
          <strong>录制中</strong>：直接在键盘上按键{fixed ? '（统一间隔时只记录顺序）' : '，按键之间的真实时间也会记录'}。录完后点“停止录制”或连按两次 Esc，会替换现有步骤；用来停止的这两次 Esc 不会录进去。
          <div className="rec-events">
            {rec.length === 0 ? <span className="muted">等待按键…</span> : rec.slice(-24).map((ev, i) => (
              <span key={i} className={`rec-ev rec-${ev.dir}`}>{ev.dir === 'down' ? '↓' : '↑'}{codeShort(ev.ref)}</span>
            ))}
          </div>
        </div>
      )}

      <ol className="steps">
        {action.steps.length === 0 && !rec && <li className="steps-empty">还没有步骤。用下面的按钮添加，或点“录制”直接按键。</li>}
        {action.steps.map((s, i) => {
          const kind = kindOf(s)
          const problems = stepIssues.get(i)
          return (
            <li key={i} className={`step${problems ? ' is-bad' : ''}${picker?.mode === 'edit' && picker.index === i ? ' is-editing' : ''}`}>
              <span className="step-no mono">{i + 1}</span>
              {kind === 'wait' ? (
                <div className="step-wait">
                  <span className="step-kind">等待</span>
                  <NumberField compact label={`第 ${i + 1} 步等待时间`} min={0} max={MAX_WAIT} value={(s as { wait: number }).wait}
                    onChange={(wait) => setSteps(action.steps.map((x, j) => (j === i ? { wait } : x)), `macro-wait-${i}`)} />
                </div>
              ) : (
                <div className="step-key">
                  <select
                    aria-label={`第 ${i + 1} 步动作`}
                    value={kind}
                    onChange={(e) => setSteps(action.steps.map((x, j) => (j === i ? makeStep(e.target.value as KeyKind, stepCode(s as Exclude<MacroStep, { wait: number }>)) : x)))}
                  >
                    {(Object.keys(KIND_ZH) as KeyKind[]).map((k) => <option key={k} value={k}>{KIND_ZH[k]}</option>)}
                  </select>
                  <button type="button" className="step-code" onClick={() => setPicker({ mode: 'edit', index: i })} title="点击更换按键">
                    <span className="mono">{codeShort(stepCode(s as Exclude<MacroStep, { wait: number }>))}</span>
                    <span className="chip-name">{codeZh(stepCode(s as Exclude<MacroStep, { wait: number }>))}</span>
                  </button>
                </div>
              )}
              <div className="step-tools">
                <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`第 ${i + 1} 步上移`}><Icon name="up" size={14} /></button>
                <button type="button" className="icon-btn" disabled={i === action.steps.length - 1} onClick={() => move(i, 1)} aria-label={`第 ${i + 1} 步下移`}><Icon name="down" size={14} /></button>
                <button type="button" className="icon-btn" onClick={() => setSteps(action.steps.filter((_, j) => j !== i))} aria-label={`删除第 ${i + 1} 步`}><Icon name="x" size={14} /></button>
              </div>
              {problems && <p className="step-issue">{problems.join('；')}</p>}
            </li>
          )
        })}
      </ol>

      <div className="row-actions add-steps">
        {(Object.keys(KIND_ZH) as KeyKind[]).map((k) => (
          <button key={k} type="button" className={`btn btn-sm${picker?.mode === 'add' && picker.kind === k ? ' is-on' : ''}`} disabled={rec !== null}
            onClick={() => setPicker(picker?.mode === 'add' && picker.kind === k ? null : { mode: 'add', kind: k })}>
            <Icon name="plus" size={14} />{KIND_ZH[k]}
          </button>
        ))}
        <button type="button" className="btn btn-sm" disabled={rec !== null} onClick={addWait}
          title={fixed ? '会先把“按键之间”改为逐步设置，播放效果不变' : undefined}>
          <Icon name="plus" size={14} />等待
        </button>
      </div>

      {picker && (
        <div className="picker-panel">
          <div className="picker-panel-head">
            <span>{picker.mode === 'add' ? `添加“${KIND_ZH[picker.kind]}”步骤：选择按键（可连续添加）` : `更换第 ${picker.index + 1} 步的按键`}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicker(null)}>完成</button>
          </div>
          <CodePicker inList autoFocus onPick={pick} value={editedStep && !('wait' in editedStep) ? stepCode(editedStep) : null} />
        </div>
      )}

      <fieldset className="macro-play">
        <legend>播放设置</legend>
        <div className="field">
          <span className="field-label">播放方式</span>
          <Segmented<MacroPlay>
            label="播放方式"
            size="sm"
            block
            value={action.play}
            onChange={setPlay}
            options={[
              { value: 'repeat', label: PLAY_ZH.repeat },
              { value: 'hold', label: experimental('hold'), hint: '实验性：还没有在真机上验证过' },
              { value: 'toggle', label: experimental('toggle'), hint: '实验性：还没有在真机上验证过' },
            ]}
          />
          {action.play === 'repeat' ? (
            <div className="macro-sentence">
              按一下，整段播放
              <NumberField compact label="播放遍数" unit="" min={1} max={255} value={action.repeat ?? 1} onChange={(repeat) => onChange({ ...action, repeat }, 'macro-repeat')} />
              遍
            </div>
          ) : (
            <p className="macro-sentence">{PLAY_HINT[action.play]}</p>
          )}
        </div>

        <div className="field">
          <span className="field-label">按键之间</span>
          <div className="macro-timing" ref={timingBox}>
            <Segmented<Timing>
              label="按键之间"
              size="sm"
              value={fixed ? 'fixed' : 'recorded'}
              onChange={setTiming}
              options={[
                { value: 'fixed', label: '统一间隔' },
                { value: 'recorded', label: '逐步设置' },
              ]}
            />
            {fixed && (
              <NumberField compact label="统一间隔（毫秒）" min={0} max={MAX_INTERVAL} value={action.interval!} onChange={(interval) => onChange({ ...action, interval }, 'macro-interval')} />
            )}
          </div>
          <p className="macro-sentence muted">
            {fixed ? `每个按下/松开之间都等 ${action.interval} ms` : '用“等待”步骤设置每段停顿；没有等待的地方是 0 ms。'}
          </p>
          {confirmInterval !== null && !fixed && (
            <div
              className="note macro-confirm"
              role="group"
              aria-label="改为统一间隔"
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                e.stopPropagation()
                closeConfirm(false)
              }}
            >
              <span>将删除 {waits} 个“等待”步骤，改为统一间隔</span>
              <NumberField compact label="统一间隔（毫秒）" min={0} max={MAX_INTERVAL} value={confirmInterval} onChange={setConfirmInterval} />
              <span className="row-actions">
                <button type="button" className="btn btn-sm btn-ink" autoFocus onClick={() => closeConfirm(true)}>确定</button>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => closeConfirm(false)}>取消</button>
              </span>
            </div>
          )}
          {timingNote?.steps === action.steps && (
            <p className={`note${timingNote.warn ? ' note-warn' : ''}`} role={timingNote.warn ? 'alert' : 'status'}>{timingNote.text}</p>
          )}
        </div>
      </fieldset>

      <div className="meter" role="group" aria-label="宏的容量" title={`${bytes} / ${MACRO_MAX_DATA_BYTES} 字节 · ${events} 个按键事件 · ${packets} 个数据包`}>
        <div className="meter-bar">
          <span className={`meter-fill${bytes > MACRO_MAX_DATA_BYTES ? ' is-over' : bytes > VERIFIED_BYTES ? ' is-high' : ''}`}
            style={{ width: `${Math.min(100, (bytes / MACRO_MAX_DATA_BYTES) * 100)}%` }} />
          <span className="meter-tick" style={{ left: `${(VERIFIED_BYTES / MACRO_MAX_DATA_BYTES) * 100}%` }} title="真机上测试过的最长宏" />
        </div>
        <p className="meter-text">容量 已用 {used}%</p>
        {bytes > VERIFIED_BYTES && bytes <= MACRO_MAX_DATA_BYTES && (
          <p className="note">这个宏比真机上测试过的最长宏更长，写入后请实际试一试。</p>
        )}
      </div>
    </div>
  )
}
