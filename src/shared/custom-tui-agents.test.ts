import { describe, expect, it } from 'vitest'
import type { CustomTuiAgent, CustomTuiAgentId, DeletedCustomTuiAgent } from './types'
import {
  canonicalizeCommandOverride,
  getAgentIdentity,
  isCustomTuiAgentId,
  measureCustomAgentEnvBytes,
  mintCustomTuiAgentId,
  MAX_CUSTOM_AGENT_ENV_BYTES,
  normalizeAgentCatalog,
  normalizeAgentLabelKey,
  parseCustomTuiAgentId,
  resolveTuiAgentBaseAgent,
  resolveTuiAgentConfig,
  truncateAgentLabelForDisplay,
  validateAgentLabel,
  validateBuiltInArgs,
  validateBuiltInCommandOverride,
  validateCommandOverride,
  validateCustomAgentEnv
} from './custom-tui-agents'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

const UUID_A = '01234567-89ab-4cde-8f01-23456789abcd'
const UUID_B = 'fedcba98-7654-4321-8fed-cba987654321'

function customId(base: string, uuid = UUID_A): CustomTuiAgentId {
  return `custom-agent:${base}:${uuid}` as CustomTuiAgentId
}

function liveAgent(overrides: Partial<CustomTuiAgent> = {}): CustomTuiAgent {
  return {
    id: customId('codex'),
    baseAgent: 'codex',
    label: 'My Codex',
    args: '',
    env: {},
    syncEnv: false,
    ...overrides
  }
}

describe('custom agent id grammar', () => {
  it('accepts only canonical lowercase UUID suffixes with a known encoded base', () => {
    expect(isCustomTuiAgentId(customId('codex'))).toBe(true)
    expect(isCustomTuiAgentId(customId('claude-agent-teams'))).toBe(true)
    expect(isCustomTuiAgentId(`custom-agent:codex:${UUID_A.toUpperCase()}`)).toBe(false)
    expect(isCustomTuiAgentId('custom-agent:codex:not-a-uuid')).toBe(false)
    expect(isCustomTuiAgentId(`custom-agent:not-a-base:${UUID_A}`)).toBe(false)
    expect(isCustomTuiAgentId(`agent-profile:codex:${UUID_A}`)).toBe(false)
    expect(isCustomTuiAgentId('codex')).toBe(false)
    expect(isCustomTuiAgentId(42)).toBe(false)
  })

  it('parses the encoded base without granting authority', () => {
    expect(parseCustomTuiAgentId(customId('claude'))).toEqual({
      baseAgent: 'claude',
      suffix: UUID_A
    })
    expect(parseCustomTuiAgentId(`custom-agent:nope:${UUID_A}`)).toBeNull()
  })

  it('mints canonical ids', () => {
    const id = mintCustomTuiAgentId('codex')
    expect(isCustomTuiAgentId(id)).toBe(true)
    expect(parseCustomTuiAgentId(id)?.baseAgent).toBe('codex')
  })
})

describe('label normalization', () => {
  it('trims, NFKC-normalizes, collapses whitespace runs, and case-folds the key', () => {
    expect(normalizeAgentLabelKey('  My   Agent  ')).toBe('my agent')
    // NFKC: fullwidth letters normalize to ASCII.
    expect(normalizeAgentLabelKey('Ｃｏｄｅｘ')).toBe('codex')
    // Non-space Unicode whitespace collapses too.
    expect(normalizeAgentLabelKey('a b')).toBe('a b')
  })

  it('bounds labels at 80 UTF-16 code units after normalization', () => {
    expect(validateAgentLabel('x'.repeat(80))).toBeNull()
    expect(validateAgentLabel('x'.repeat(81))).toEqual({ field: 'label', reason: 'bounds' })
    expect(validateAgentLabel('')).toEqual({ field: 'label', reason: 'empty' })
    expect(validateAgentLabel('   ')).toEqual({ field: 'label', reason: 'empty' })
  })

  it('truncates surrogate-safely for display only', () => {
    const label = 'ab💩'
    expect(truncateAgentLabelForDisplay(label, 3)).toBe('ab')
    expect(truncateAgentLabelForDisplay(label, 4)).toBe('ab💩')
  })
})

describe('env validation', () => {
  it('accepts a valid map', () => {
    expect(validateCustomAgentEnv({ FOO: 'bar', A_1: 'x y = z' })).toEqual([])
  })

  it('rejects prototype-polluting, reserved, malformed, and case-colliding keys', () => {
    expect(validateCustomAgentEnv({ __proto__: 'x' })).toEqual([])
    // Object literal __proto__ does not create an own property; use a crafted object.
    const proto = JSON.parse('{"__proto__": "x"}') as Record<string, string>
    expect(validateCustomAgentEnv(proto)).toEqual([
      { field: 'env', reason: 'prototype_key', envEntryIndex: 0 }
    ])
    expect(validateCustomAgentEnv({ ORCA_PANE_KEY: 'x' })).toEqual([
      { field: 'env', reason: 'reserved_name', envEntryIndex: 0 }
    ])
    expect(validateCustomAgentEnv({ orca_thing: 'x' })).toEqual([
      { field: 'env', reason: 'reserved_name', envEntryIndex: 0 }
    ])
    expect(validateCustomAgentEnv({ '1BAD': 'x' })).toEqual([
      { field: 'env', reason: 'bounds', envEntryIndex: 0 }
    ])
    expect(validateCustomAgentEnv({ 'BAD-NAME': 'x' })).toEqual([
      { field: 'env', reason: 'bounds', envEntryIndex: 0 }
    ])
    expect(validateCustomAgentEnv({ Path: 'a', PATH: 'b' })).toEqual([
      { field: 'env', reason: 'case_collision', envEntryIndex: 1 }
    ])
  })

  it('rejects NUL and newline in values and over-bound sizes', () => {
    expect(validateCustomAgentEnv({ FOO: 'a\nb' })).toEqual([
      { field: 'env', reason: 'control_char', envEntryIndex: 0 }
    ])
    expect(validateCustomAgentEnv({ FOO: 'a\0b' })).toEqual([
      { field: 'env', reason: 'control_char', envEntryIndex: 0 }
    ])
    expect(validateCustomAgentEnv({ FOO: 'x'.repeat(4097) })).toEqual([
      { field: 'env', reason: 'bounds', envEntryIndex: 0 }
    ])
    const tooMany: Record<string, string> = {}
    for (let i = 0; i < 65; i += 1) {
      tooMany[`KEY_${i}`] = 'v'
    }
    expect(validateCustomAgentEnv(tooMany)).toContainEqual({ field: 'env', reason: 'bounds' })
  })

  it('enforces the 16 KiB aggregate bound as the larger of UTF-8 and UTF-16 measures', () => {
    // 4 entries x ~4096-unit values exceed 16384 in both measures.
    const env: Record<string, string> = {}
    for (let i = 0; i < 4; i += 1) {
      env[`K${i}`] = 'v'.repeat(4096)
    }
    expect(validateCustomAgentEnv(env)).toEqual([{ field: 'env', reason: 'env_total_bounds' }])
    // Multi-byte UTF-8: the UTF-8 measure trips the cap even when UTF-16 units fit.
    const multiByte: Record<string, string> = {}
    for (let i = 0; i < 5; i += 1) {
      multiByte[`M${i}`] = '€'.repeat(1200)
    }
    expect(measureCustomAgentEnvBytes(multiByte)).toBeGreaterThan(MAX_CUSTOM_AGENT_ENV_BYTES)
    expect(validateCustomAgentEnv(multiByte)).toEqual([
      { field: 'env', reason: 'env_total_bounds' }
    ])
  })
})

describe('command override validation', () => {
  it('accepts paths with spaces and ordinary metacharacters as one argv element', () => {
    expect(validateCommandOverride('/usr/local/bin/codex')).toBeNull()
    expect(validateCommandOverride('C:\\Program Files\\Codex\\codex.exe')).toBeNull()
    expect(validateCommandOverride('/opt/tools (beta)/codex%20/run')).toBeNull()
    expect(validateCommandOverride('/opt/a&b/codex')).toBeNull()
    expect(validateCommandOverride(undefined)).toBeNull()
  })

  it('decodes one matched pair of outer quotes', () => {
    expect(canonicalizeCommandOverride('"/path with spaces/codex"')).toBe('/path with spaces/codex')
    expect(canonicalizeCommandOverride("'/path/codex'")).toBe('/path/codex')
    expect(canonicalizeCommandOverride('/plain/codex')).toBe('/plain/codex')
    // Embedded same-quote characters keep the raw value (no second decode).
    expect(canonicalizeCommandOverride('"a"b"')).toBe('"a"b"')
  })

  it('accepts a multi-token built-in wrapper that the one-executable rule rejects', () => {
    // Built-in overrides keep wrapper compatibility; only control chars and bounds fail.
    expect(validateBuiltInCommandOverride('mise exec -- codex')).toBeNull()
    expect(validateBuiltInCommandOverride('codex && rm -rf /')).toBeNull()
    expect(validateBuiltInCommandOverride(null)).toBeNull()
    expect(validateBuiltInCommandOverride('a\nb')).toEqual({
      field: 'commandOverride',
      reason: 'control_char'
    })
    expect(validateBuiltInCommandOverride('x'.repeat(4097))).toEqual({
      field: 'commandOverride',
      reason: 'bounds'
    })
  })

  it('bounds built-in args by length only, without the v1 grammar', () => {
    expect(validateBuiltInArgs('--model "gpt')).toBeNull()
    expect(validateBuiltInArgs('x'.repeat(8193))).toEqual({ field: 'args', reason: 'bounds' })
  })

  it('rejects control characters, unbalanced quoting, operators, and bounds', () => {
    expect(validateCommandOverride('a\nb')).toEqual({
      field: 'commandOverride',
      reason: 'control_char'
    })
    expect(validateCommandOverride('"unclosed')).toEqual({
      field: 'commandOverride',
      reason: 'unterminated_quote'
    })
    expect(validateCommandOverride('codex && rm -rf /')).toEqual({
      field: 'commandOverride',
      reason: 'shell_operator'
    })
    expect(validateCommandOverride('codex | tee log')).toEqual({
      field: 'commandOverride',
      reason: 'shell_operator'
    })
    expect(validateCommandOverride('a > b')).toEqual({
      field: 'commandOverride',
      reason: 'shell_operator'
    })
    expect(validateCommandOverride('x'.repeat(4097))).toEqual({
      field: 'commandOverride',
      reason: 'bounds'
    })
    expect(validateCommandOverride('  ')).toEqual({ field: 'commandOverride', reason: 'empty' })
  })
})

describe('normalizeAgentCatalog', () => {
  it('indexes valid live agents in creation order and preserves index order', () => {
    const first = liveAgent({ id: customId('codex', UUID_A), label: 'First' })
    const second = liveAgent({
      id: customId('claude', UUID_B),
      baseAgent: 'claude',
      label: 'Second'
    })
    const { catalog } = normalizeAgentCatalog({
      customTuiAgents: [first, second],
      deletedCustomTuiAgents: [],
      disabledTuiAgents: [],
      defaultTuiAgent: 'auto'
    })
    expect(catalog.liveCustomAgents.map((agent) => agent.label)).toEqual(['First', 'Second'])
    expect(catalog.liveById.get(first.id)?.label).toBe('First')
    expect(catalog.corruptRows).toEqual([])
    expect(catalog.defaultAgent).toBe('auto')
  })

  it('lets a same-id tombstone win over a live row', () => {
    const id = customId('codex')
    const tombstone: DeletedCustomTuiAgent = {
      id,
      baseAgent: 'codex',
      label: 'Old',
      deletedAt: 123
    }
    const { catalog } = normalizeAgentCatalog({
      customTuiAgents: [liveAgent({ id })],
      deletedCustomTuiAgents: [tombstone],
      disabledTuiAgents: [],
      defaultTuiAgent: 'auto'
    })
    expect(catalog.liveById.has(id)).toBe(false)
    expect(catalog.tombstonesById.get(id)?.label).toBe('Old')
  })

  it('marks base/id mismatch as corrupt, never rewriting either side', () => {
    const row = liveAgent({
      id: customId('codex'),
      baseAgent: 'claude' as CustomTuiAgent['baseAgent']
    })
    const { catalog } = normalizeAgentCatalog({
      customTuiAgents: [row],
      deletedCustomTuiAgents: [],
      disabledTuiAgents: [],
      defaultTuiAgent: 'auto'
    })
    expect(catalog.liveById.size).toBe(0)
    expect(catalog.corruptRows).toHaveLength(1)
    expect(catalog.corruptRows[0].issues).toContainEqual({
      field: 'identity',
      reason: 'identity_mismatch'
    })
  })

  it('quarantines duplicate live ids as a group', () => {
    const id = customId('codex')
    const { catalog } = normalizeAgentCatalog({
      customTuiAgents: [liveAgent({ id, label: 'One' }), liveAgent({ id, label: 'Two' })],
      deletedCustomTuiAgents: [],
      disabledTuiAgents: [],
      defaultTuiAgent: 'auto'
    })
    expect(catalog.liveById.size).toBe(0)
    expect(catalog.corruptRows).toHaveLength(2)
    for (const row of catalog.corruptRows) {
      expect(row.issues).toContainEqual({ field: 'identity', reason: 'duplicate_id' })
    }
  })

  it('keeps repair-required rows addressable but not live', () => {
    const row = liveAgent({ label: '' })
    const { catalog } = normalizeAgentCatalog({
      customTuiAgents: [row],
      deletedCustomTuiAgents: [],
      disabledTuiAgents: [],
      defaultTuiAgent: 'auto'
    })
    expect(catalog.liveById.size).toBe(0)
    expect(catalog.repairRequiredById.get(row.id)?.issues).toContainEqual({
      field: 'label',
      reason: 'empty'
    })
  })

  it('normalizes missing syncEnv to false and canonicalizes the stored label', () => {
    const { catalog } = normalizeAgentCatalog({
      customTuiAgents: [{ ...liveAgent({ label: '  My   Agent ' }), syncEnv: undefined }],
      deletedCustomTuiAgents: [],
      disabledTuiAgents: [],
      defaultTuiAgent: 'auto'
    })
    const stored = catalog.liveCustomAgents[0]
    expect(stored.syncEnv).toBe(false)
    expect(stored.label).toBe('My Agent')
  })

  it('keeps only known built-ins or live/repair custom ids in the disabled set', () => {
    const live = liveAgent()
    const { catalog } = normalizeAgentCatalog({
      customTuiAgents: [live],
      deletedCustomTuiAgents: [],
      disabledTuiAgents: ['codex', live.id, customId('claude', UUID_B), 'garbage'],
      defaultTuiAgent: 'auto'
    })
    expect(catalog.disabledAgents.has('codex')).toBe(true)
    expect(catalog.disabledAgents.has(live.id)).toBe(true)
    expect(catalog.disabledAgents.has(customId('claude', UUID_B))).toBe(false)
  })

  describe('default reference validation', () => {
    it('keeps a live disabled or tombstoned custom default as a stored reference', () => {
      const live = liveAgent()
      const disabledResult = normalizeAgentCatalog({
        customTuiAgents: [live],
        deletedCustomTuiAgents: [],
        disabledTuiAgents: [live.id],
        defaultTuiAgent: live.id
      })
      expect(disabledResult.catalog.defaultAgent).toBe(live.id)
      expect(disabledResult.defaultRepairedToNull).toBe(false)

      const tombstoned = normalizeAgentCatalog({
        customTuiAgents: [],
        deletedCustomTuiAgents: [
          { id: live.id, baseAgent: 'codex', label: 'My Codex', deletedAt: 1 }
        ],
        disabledTuiAgents: [],
        defaultTuiAgent: live.id
      })
      expect(tombstoned.catalog.defaultAgent).toBe(live.id)
    })

    it('repairs an unknown custom default to null (id syntax grants nothing)', () => {
      const result = normalizeAgentCatalog({
        customTuiAgents: [],
        deletedCustomTuiAgents: [],
        disabledTuiAgents: [],
        defaultTuiAgent: customId('codex', UUID_B)
      })
      expect(result.catalog.defaultAgent).toBeNull()
      expect(result.defaultRepairedToNull).toBe(true)
    })

    it('repairs a default whose base is disabled to null', () => {
      const live = liveAgent()
      const derivative = normalizeAgentCatalog({
        customTuiAgents: [live],
        deletedCustomTuiAgents: [],
        disabledTuiAgents: ['codex'],
        defaultTuiAgent: live.id
      })
      expect(derivative.catalog.defaultAgent).toBeNull()
      expect(derivative.defaultRepairedToNull).toBe(true)

      const builtIn = normalizeAgentCatalog({
        customTuiAgents: [],
        deletedCustomTuiAgents: [],
        disabledTuiAgents: ['codex'],
        defaultTuiAgent: 'codex'
      })
      expect(builtIn.catalog.defaultAgent).toBeNull()
      expect(builtIn.defaultRepairedToNull).toBe(true)
    })

    it('never converts blank, auto, and null into one another', () => {
      for (const value of ['auto', 'blank', null] as const) {
        const result = normalizeAgentCatalog({
          customTuiAgents: [],
          deletedCustomTuiAgents: [],
          disabledTuiAgents: [],
          defaultTuiAgent: value
        })
        expect(result.catalog.defaultAgent).toBe(value)
        expect(result.defaultRepairedToNull).toBe(false)
      }
    })
  })

  it('ignores malformed tombstones as launch authority while never inventing one', () => {
    const badTombstone = {
      id: 'custom-agent:codex:not-a-uuid',
      baseAgent: 'codex',
      label: 'Bad',
      deletedAt: 1
    }
    const { catalog } = normalizeAgentCatalog({
      customTuiAgents: [],
      deletedCustomTuiAgents: [badTombstone],
      disabledTuiAgents: [],
      defaultTuiAgent: 'auto'
    })
    expect(catalog.tombstonesById.size).toBe(0)
  })
})

describe('getAgentIdentity', () => {
  const live = liveAgent()
  const tombstoneId = customId('claude', UUID_B)
  const { catalog } = normalizeAgentCatalog({
    customTuiAgents: [live],
    deletedCustomTuiAgents: [{ id: tombstoneId, baseAgent: 'claude', label: 'Gone', deletedAt: 1 }],
    disabledTuiAgents: [],
    defaultTuiAgent: 'auto'
  })

  it('resolves built-ins, live customs, and tombstones distinctly', () => {
    expect(getAgentIdentity('codex', catalog)).toEqual({
      kind: 'built-in',
      requestedAgent: 'codex',
      baseAgent: 'codex'
    })
    expect(getAgentIdentity(live.id, catalog)).toMatchObject({
      kind: 'custom',
      baseAgent: 'codex'
    })
    expect(getAgentIdentity(tombstoneId, catalog)).toMatchObject({
      kind: 'deleted',
      baseAgent: 'claude'
    })
  })

  it('returns null for well-formed but unknown ids', () => {
    expect(getAgentIdentity(customId('codex', UUID_B), catalog)).toBeNull()
  })
})

describe('resolveTuiAgentBaseAgent', () => {
  const live = liveAgent()
  it('returns proven bases only', () => {
    expect(resolveTuiAgentBaseAgent('claude')).toBe('claude')
    expect(resolveTuiAgentBaseAgent(live.id, [live])).toBe('codex')
    expect(
      resolveTuiAgentBaseAgent(
        customId('claude', UUID_B),
        [live],
        [{ id: customId('claude', UUID_B), baseAgent: 'claude', label: 'Gone', deletedAt: 1 }]
      )
    ).toBe('claude')
    expect(resolveTuiAgentBaseAgent(customId('codex', UUID_B), [live])).toBeNull()
    expect(resolveTuiAgentBaseAgent(null)).toBeNull()
  })
})

describe('resolveTuiAgentConfig (base accessor, oracle 16)', () => {
  const live = liveAgent() // baseAgent: 'codex'
  const tombstone: DeletedCustomTuiAgent = {
    id: customId('claude', UUID_B),
    baseAgent: 'claude',
    label: 'Gone',
    deletedAt: 1
  }

  it('returns the base config for a built-in id (identity)', () => {
    expect(resolveTuiAgentConfig('claude')).toBe(TUI_AGENT_CONFIG.claude)
  })

  it('resolves a live custom id to its base config, never undefined', () => {
    const config = resolveTuiAgentConfig(live.id, [live])
    expect(config).toBe(TUI_AGENT_CONFIG.codex)
    // The oracle-16 hazard: a raw TUI_AGENT_CONFIG[customId] would be undefined.
    expect(config).not.toBeUndefined()
    expect(config?.promptInjectionMode).toBe(TUI_AGENT_CONFIG.codex.promptInjectionMode)
  })

  it('resolves a tombstoned custom id to its base config', () => {
    expect(resolveTuiAgentConfig(tombstone.id, [], [tombstone])).toBe(TUI_AGENT_CONFIG.claude)
  })

  it('returns null for an unresolvable or empty id (never a static-map read)', () => {
    expect(resolveTuiAgentConfig(customId('codex', UUID_B), [live])).toBeNull()
    expect(resolveTuiAgentConfig(null)).toBeNull()
    expect(resolveTuiAgentConfig(undefined)).toBeNull()
  })
})
