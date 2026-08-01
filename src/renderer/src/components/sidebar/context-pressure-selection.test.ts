import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { GlobalSettings } from '../../../../shared/types'
import {
  alertOnlyContextPressure,
  buildTabContextPressureIndex,
  getContextPressureConfig,
  getWorstContextPressureSnapshot,
  resolveEntryContextPressure
} from './context-pressure-selection'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function settings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    experimentalContextPressure: true,
    contextPressureWarnPercent: 70,
    contextPressureCriticalPercent: 90,
    ...overrides
  } as GlobalSettings
}

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: `tab-1:${LEAF_A}`,
    state: 'working',
    prompt: 'do the thing',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    agentType: 'claude',
    model: 'claude-opus-4-6',
    contextUsage: { usedTokens: 100_000, maxTokens: 200_000 },
    ...overrides
  }
}

describe('getContextPressureConfig', () => {
  it('returns null when the master flag is off or settings are missing', () => {
    expect(getContextPressureConfig(null)).toBeNull()
    expect(getContextPressureConfig(undefined)).toBeNull()
    expect(getContextPressureConfig(settings({ experimentalContextPressure: false }))).toBeNull()
    expect(
      getContextPressureConfig(settings({ experimentalContextPressure: undefined }))
    ).toBeNull()
  })

  it('falls back to the 70/90 defaults when thresholds are unset', () => {
    const config = getContextPressureConfig(
      settings({ contextPressureWarnPercent: undefined, contextPressureCriticalPercent: undefined })
    )
    expect(config).toEqual({ warnPercent: 70, criticalPercent: 90, softLimits: undefined })
  })

  it('keeps a stable reference across settings objects with equal values', () => {
    const first = getContextPressureConfig(
      settings({ contextPressureSoftLimits: { claude: 150_000 } })
    )
    const second = getContextPressureConfig(
      settings({ contextPressureSoftLimits: { claude: 150_000 } })
    )
    expect(second).toBe(first)

    const changed = getContextPressureConfig(
      settings({ contextPressureSoftLimits: { claude: 100_000 } })
    )
    expect(changed).not.toBe(first)
    expect(changed?.softLimits).toEqual({ claude: 100_000 })
  })
})

describe('resolveEntryContextPressure', () => {
  const config = { warnPercent: 70, criticalPercent: 90 }

  it('returns null without a config (flag off) or without provider data', () => {
    expect(resolveEntryContextPressure(entry(), null)).toBeNull()
    expect(resolveEntryContextPressure(entry({ contextUsage: undefined }), config)).toBeNull()
    expect(resolveEntryContextPressure(entry({ contextUsage: null }), config)).toBeNull()
  })

  it('resolves the traffic light from the provider-reported window', () => {
    const snapshot = resolveEntryContextPressure(entry(), config)
    expect(snapshot).toEqual({
      level: 'ok',
      usedTokens: 100_000,
      limitTokens: 200_000,
      usedPercent: 50,
      limitSource: 'provider'
    })
  })

  it('falls back to the model table when the provider reports no max', () => {
    // claude-sonnet-4-5 sits on the 200k Claude floor in the model table.
    const snapshot = resolveEntryContextPressure(
      entry({ model: 'claude-sonnet-4-5', contextUsage: { usedTokens: 190_000 } }),
      config
    )
    expect(snapshot?.limitTokens).toBe(200_000)
    expect(snapshot?.limitSource).toBe('model')
    expect(snapshot?.level).toBe('critical')
  })

  it('lets a lower soft cap bind the effective limit', () => {
    const snapshot = resolveEntryContextPressure(entry(), {
      ...config,
      softLimits: { 'model:claude-opus-4-6': 120_000 }
    })
    expect(snapshot?.limitTokens).toBe(120_000)
    expect(snapshot?.limitSource).toBe('soft-cap')
    expect(snapshot?.level).toBe('warning')
  })
})

describe('getWorstContextPressureSnapshot', () => {
  const config = { warnPercent: 70, criticalPercent: 90 }

  it('picks the highest level, breaking level ties by usedPercent', () => {
    const entries = [
      entry({ contextUsage: { usedTokens: 100_000, maxTokens: 200_000 } }), // ok
      entry({ contextUsage: { usedTokens: 160_000, maxTokens: 200_000 } }), // warning 80%
      entry({ contextUsage: { usedTokens: 150_000, maxTokens: 200_000 } }) // warning 75%
    ]
    const worst = getWorstContextPressureSnapshot(entries, config)
    expect(worst?.level).toBe('warning')
    expect(worst?.usedTokens).toBe(160_000)
  })

  it('excludes sessions without data and returns null when none report', () => {
    const known = entry({ contextUsage: { usedTokens: 195_000, maxTokens: 200_000 } })
    const unknown = entry({ contextUsage: undefined })
    expect(getWorstContextPressureSnapshot([unknown, known], config)?.level).toBe('critical')
    expect(getWorstContextPressureSnapshot([unknown], config)).toBeNull()
    expect(getWorstContextPressureSnapshot([], config)).toBeNull()
  })

  it('reuses the cached snapshot for the same entries array and config', () => {
    const entries = [entry()]
    const first = getWorstContextPressureSnapshot(entries, config)
    expect(getWorstContextPressureSnapshot(entries, config)).toBe(first)
    // A different config must not serve the stale verdict.
    const stricter = getWorstContextPressureSnapshot(entries, {
      warnPercent: 10,
      criticalPercent: 20
    })
    expect(stricter?.level).toBe('critical')
  })
})

describe('buildTabContextPressureIndex', () => {
  const config = { warnPercent: 70, criticalPercent: 90 }

  it('keeps the worst snapshot per tab and skips malformed pane keys', () => {
    const index = buildTabContextPressureIndex(
      {
        [`tab-1:${LEAF_A}`]: entry({
          contextUsage: { usedTokens: 100_000, maxTokens: 200_000 }
        }),
        [`tab-1:${LEAF_B}`]: entry({
          paneKey: `tab-1:${LEAF_B}`,
          contextUsage: { usedTokens: 195_000, maxTokens: 200_000 }
        }),
        [`tab-2:${LEAF_A}`]: entry({
          paneKey: `tab-2:${LEAF_A}`,
          contextUsage: undefined
        }),
        'not-a-pane-key': entry({ paneKey: 'not-a-pane-key' })
      },
      config
    )
    expect(index.get('tab-1')?.level).toBe('critical')
    expect(index.has('tab-2')).toBe(false)
    expect(index.has('not-a-pane-key')).toBe(false)
    expect(index.size).toBe(1)
  })

  it('reuses the index for the same status map and config', () => {
    const statusMap = { [`tab-1:${LEAF_A}`]: entry() }
    const first = buildTabContextPressureIndex(statusMap, config)
    expect(buildTabContextPressureIndex(statusMap, config)).toBe(first)
    expect(buildTabContextPressureIndex({ ...statusMap }, config)).not.toBe(first)
  })
})

describe('alertOnlyContextPressure', () => {
  it("mutes 'ok' and passes warning/critical through", () => {
    const config = { warnPercent: 70, criticalPercent: 90 }
    const ok = resolveEntryContextPressure(entry(), config)
    const critical = resolveEntryContextPressure(
      entry({ contextUsage: { usedTokens: 195_000, maxTokens: 200_000 } }),
      config
    )
    expect(alertOnlyContextPressure(ok)).toBeNull()
    expect(alertOnlyContextPressure(critical)).toBe(critical)
    expect(alertOnlyContextPressure(null)).toBeNull()
  })
})
