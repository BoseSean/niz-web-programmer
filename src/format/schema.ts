/**
 * Generator of format/plum-keymap.schema.json (JSON Schema 2020-12 for the Profile input form, shorthands included).
 * The schema file is checked against buildSchema() by format.test.ts; `UPDATE_EXAMPLES=1 npx vitest run src/format`
 * rewrites it. The schema checks structure only; normalizeProfile() adds the semantic rules (toggle pairing, Fn rule,
 * macro length, ...).
 */
import { CODES } from '../device/codes'
import { KEYS } from '../device/layout'

const ref = (name: string) => ({ $ref: `#/$defs/${name}` })

const named = (action: string, description: string) => ({
  description,
  type: 'object',
  required: ['name', 'action'],
  additionalProperties: false,
  properties: { name: { type: 'string', description: '名称 (name)' }, action: ref(action) },
})

const step = (kind: string, value: object) => ({
  type: 'object',
  required: [kind],
  additionalProperties: false,
  properties: { [kind]: value },
})

export function buildSchema(): Record<string, unknown> {
  const keyIds = KEYS.map((k) => k.id)
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Plum Keymap (84EC-S)',
    description:
      'NIZ / Plum 84EC-S 键盘的按键方案：每个物理按键在常规层 (base) 与 Fn 层 (fn) 上的动作 (key map for the NIZ / Plum 84EC-S: what every physical key does on the base and Fn layers)',
    type: 'object',
    required: ['format', 'version', 'device', 'layers'],
    additionalProperties: false,
    properties: {
      $schema: { type: 'string', description: '本 schema 的地址，供编辑器使用 (URL of this schema, for editors)' },
      format: { const: 'plum-keymap', description: '文件格式标识 (format identifier)' },
      version: { const: 1, description: '格式版本 (format version)' },
      device: { const: '84EC-S', description: '目标键盘型号 (target keyboard model)' },
      name: { type: 'string', description: '方案名称 (profile name)' },
      description: { type: 'string', description: '方案说明 (profile description)' },
      inherit: {
        enum: ['factory', 'none'],
        default: 'none',
        description:
          '未列出按键的动作："factory" = 出厂默认，"none" = 无动作 (what keys not listed do: "factory" = factory default, "none" = nothing)',
      },
      layers: {
        type: 'object',
        description: '两层按键映射 (the two key layers)',
        required: ['base', 'fn'],
        additionalProperties: false,
        properties: {
          base: { ...ref('layer'), description: '常规层 / 上档键 (base layer)' },
          fn: { ...ref('layer'), description: 'Fn 层 / 下档键，按住 Fn 时生效 (Fn layer, active while Fn is held)' },
        },
      },
      library: {
        type: 'object',
        description:
          '预定义的组合键 / 宏 / 模拟击键，不写入键盘 (predefined combos / macros / emulates; not sent to the keyboard)',
        additionalProperties: false,
        properties: {
          combos: { type: 'array', items: ref('namedCombo'), description: '组合键库 (combo library)' },
          macros: { type: 'array', items: ref('namedMacro'), description: '宏库 (macro library)' },
          emulates: { type: 'array', items: ref('namedEmulate'), description: '模拟击键库 (emulate library)' },
        },
      },
      backlight: {
        type: 'object',
        description:
          '来自 KB84 .pro 文件的按键颜色 (物理按键 id → "#rrggbb")；84EC-S 没有背光，仅为往返转换保留 (per-key colors from KB84 .pro files, physical key id → "#rrggbb"; the 84EC-S has no backlight, kept only for round-trips)',
        propertyNames: { enum: keyIds },
        additionalProperties: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
      },
    },
    $defs: {
      layer: {
        type: 'object',
        description:
          '物理按键 id → 动作；未列出的按键由 "inherit" 决定 (physical key id → action; keys not listed follow "inherit")',
        additionalProperties: false,
        properties: Object.fromEntries(
          KEYS.map((k) => [k.id, { ...ref('actionInput'), description: `#${k.no} ${k.label || 'Space'}` }]),
        ),
      },
      codeId: { description: '设备键码名称 (device code id)', enum: CODES.map((c) => c.id) },
      codeRef: {
        description:
          '键码：名称，或没有名称的设备功能用 1..255 的数字 (a code: its id, or a number 1..255 for codes without a name)',
        anyOf: [ref('codeId'), { type: 'integer', minimum: 1, maximum: 255 }],
      },
      listCodeRef: {
        description:
          '列表 (组合键、宏、模拟击键) 中的键码；左键双击只能作为单键使用 (a code inside a combo, macro or emulate; MouseDoubleClick is only allowed as a single key action)',
        $ref: '#/$defs/codeRef',
        not: { enum: ['MouseDoubleClick', 199] },
      },
      actionInput: {
        description:
          '按键动作；简写：键码 = 单键，null = 无动作 (key action; shorthands: a code = single key, null = nothing)',
        anyOf: [{ type: 'null' }, ref('codeRef'), ref('action')],
      },
      action: {
        description: '完整形式的按键动作 (key action, full form)',
        type: 'object',
        required: ['type'],
        properties: { type: { enum: ['none', 'key', 'combo', 'macro', 'emulate', 'raw'] } },
        oneOf: ['noneAction', 'keyAction', 'comboAction', 'macroAction', 'emulateAction', 'rawAction'].map(ref),
      },
      noneAction: {
        description: '无动作 (does nothing)',
        type: 'object',
        required: ['type'],
        additionalProperties: false,
        properties: { type: { const: 'none' } },
      },
      keyAction: {
        description:
          '单键：普通键、多媒体键、鼠标键、操控键或电源键 (single code: keyboard, media, mouse, function or power key)',
        type: 'object',
        required: ['type', 'code'],
        additionalProperties: false,
        properties: { type: { const: 'key' }, code: ref('codeRef') },
      },
      comboAction: {
        description:
          '组合键：2..6 个键码同时按下；KB84 允许重复的键，校验器只给出警告 (combo: 2..6 codes pressed together; repeats are allowed, the validator warns)',
        type: 'object',
        required: ['type', 'keys'],
        additionalProperties: false,
        properties: {
          type: { const: 'combo' },
          keys: { type: 'array', items: ref('listCodeRef'), minItems: 2, maxItems: 6 },
        },
      },
      emulateAction: {
        description: '模拟击键：按住时快速重复 1..6 个键 (emulate: rapidly repeats 1..6 keys while held)',
        type: 'object',
        required: ['type', 'keys', 'interval'],
        additionalProperties: false,
        properties: {
          type: { const: 'emulate' },
          keys: { type: 'array', items: ref('listCodeRef'), minItems: 1, maxItems: 6 },
          interval: {
            type: 'integer',
            minimum: 0,
            maximum: 6000,
            default: 30,
            description: '速度参数，KB84 默认 30，单位未经验证 (speed parameter, KB84 default 30; unit unverified)',
          },
        },
      },
      macroAction: {
        description:
          '宏：按顺序执行的按下 / 松开 / 点按 / 等待步骤。有 interval = 固定间隔，不允许 wait 步骤；没有 interval = 由 wait 步骤给出记录延时 (macro: press / release / tap / wait steps; with "interval" every event is separated by that fixed delay and wait steps are not allowed, without it the wait steps give the recorded delays)',
        type: 'object',
        required: ['type', 'play', 'steps'],
        additionalProperties: false,
        properties: {
          type: { const: 'macro' },
          play: {
            enum: ['repeat', 'hold', 'toggle'],
            description:
              '播放方式："repeat" 次数播放，"hold" 按下播放、释放停止，"toggle" 按键开/关播放 (play mode: "repeat" N times, "hold" while held, "toggle" starts / stops on each press)',
          },
          repeat: {
            type: 'integer',
            minimum: 1,
            maximum: 255,
            description: '播放次数，"repeat" 时必填，其它方式不允许 (play count; required with "repeat", not allowed otherwise)',
          },
          interval: {
            type: 'integer',
            minimum: 0,
            maximum: 60000,
            description:
              '固定事件间隔 (毫秒)；省略则使用记录延时 (fixed delay between events in ms; omit for recorded timing)',
          },
          steps: {
            type: 'array',
            minItems: 1,
            items: ref('macroStep'),
            description:
              '宏步骤。固件按切换方式处理键码：第一次出现为按下，下一次为松开 (steps; the firmware toggles each code: its first occurrence presses it, the next releases it)',
          },
        },
        allOf: [
          {
            if: { properties: { play: { const: 'repeat' } }, required: ['play'] },
            then: { required: ['repeat'] },
            else: { not: { required: ['repeat'] } },
          },
          {
            if: { required: ['interval'] },
            then: { properties: { steps: { type: 'array', items: { not: { type: 'object', required: ['wait'] } } } } },
          },
        ],
      },
      macroStep: {
        description: '宏步骤 (macro step)',
        oneOf: [
          step('down', { description: '按下 (press)', $ref: '#/$defs/listCodeRef' }),
          step('up', { description: '松开 (release)', $ref: '#/$defs/listCodeRef' }),
          step('tap', { description: '点按 = 按下后松开 (tap = press then release)', $ref: '#/$defs/listCodeRef' }),
          step('wait', { type: 'integer', minimum: 0, maximum: 65535, description: '等待毫秒数 (pause in ms)' }),
        ],
      },
      rawAction: {
        description:
          '无法解析的槽位，按原样保存为 64 字节的十六进制报文，以 00 F0 L K 开头 (a slot that could not be interpreted, kept verbatim as 64-byte hex packets starting 00 F0 L K)',
        type: 'object',
        required: ['type', 'packets'],
        additionalProperties: false,
        properties: {
          type: { const: 'raw' },
          packets: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', pattern: '^\\s*00\\s*[Ff]0\\s*(?:[0-9A-Fa-f]{2}\\s*){62}$' },
          },
        },
      },
      namedCombo: named('comboAction', '命名组合键 (named combo)'),
      namedMacro: named('macroAction', '命名宏 (named macro)'),
      namedEmulate: named('emulateAction', '命名模拟击键 (named emulate)'),
    },
  }
}

/** The schema file's exact text. */
export const schemaText = () => JSON.stringify(buildSchema(), null, 2) + '\n'
