import { describe, it, expect } from 'vitest'
import {
  AGENT_CONTEXT_USAGE_MAX_TOKENS,
  CONTEXT_PRESSURE_SOFT_LIMIT_KEY_MAX_LENGTH,
  CONTEXT_PRESSURE_SOFT_LIMIT_MAX_ENTRIES,
  agentContextUsageEqual,
  normalizeAgentContextUsage,
  normalizeContextPressurePercent,
  normalizeContextPressureSoftLimits,
  resolveContextPressure,
  resolveContextPressureConfigFromSettings,
  type ContextPressureConfig
} from './agent-context-pressure'

const CONFIG: ContextPressureConfig = { warnPercent: 70, criticalPercent: 90 }

describe('resolveContextPressureConfigFromSettings', () => {
  it('gates disabled settings and hydrates defaults', () => {
    expect(resolveContextPressureConfigFromSettings({})).toBeNull()
    expect(resolveContextPressureConfigFromSettings({ experimentalContextPressure: true })).toEqual(
      { warnPercent: 70, criticalPercent: 90, softLimits: undefined }
    )
  })
})

describe('resolveContextPressure', () => {
  it('maps usage percent onto the traffic light at exact boundaries', () => {
    const at = (usedTokens: number) =>
      resolveContextPressure({
        usage: { usedTokens, maxTokens: 1000 },
        config: CONFIG
      })
    expect(at(0)?.level).toBe('ok')
    expect(at(699)?.level).toBe('ok')
    // Why >= at the boundary: "at the threshold" already counts as pressure.
    expect(at(700)?.level).toBe('warning')
    expect(at(899)?.level).toBe('warning')
    expect(at(900)?.level).toBe('critical')
    expect(at(1000)?.level).toBe('critical')
    expect(at(1500)?.level).toBe('critical')
  })

  it('reports used/limit/percent and the provider limit source', () => {
    const snapshot = resolveContextPressure({
      usage: { usedTokens: 250, maxTokens: 1000 },
      config: CONFIG
    })
    expect(snapshot).toEqual({
      level: 'ok',
      usedTokens: 250,
      limitTokens: 1000,
      usedPercent: 25,
      limitSource: 'provider'
    })
  })

  it('falls back to the model table when the provider reports no max', () => {
    const snapshot = resolveContextPressure({
      usage: { usedTokens: 150_000 },
      model: 'claude-sonnet-4-5',
      config: CONFIG
    })
    expect(snapshot).toMatchObject({
      level: 'warning',
      limitTokens: 200_000,
      limitSource: 'model',
      usedPercent: 75
    })
  })

  it('uses the minimum of soft cap, provider max, and model table', () => {
    const base = {
      usage: { usedTokens: 90_000, maxTokens: 200_000 } as const,
      model: 'claude-sonnet-4-5'
    }
    // Soft cap binds when lowest.
    expect(
      resolveContextPressure({
        ...base,
        config: { ...CONFIG, softLimits: { 'model:claude-sonnet-4-5': 100_000 } }
      })
    ).toMatchObject({ limitTokens: 100_000, limitSource: 'soft-cap', level: 'critical' })
    // Provider binds when it is lowest.
    expect(
      resolveContextPressure({
        usage: { usedTokens: 90_000, maxTokens: 120_000 },
        model: 'claude-sonnet-4-5',
        config: { ...CONFIG, softLimits: { 'model:claude-sonnet-4-5': 500_000 } }
      })
    ).toMatchObject({ limitTokens: 120_000, limitSource: 'provider' })
    // Model table binds when the provider max is larger and no soft cap exists.
    expect(
      resolveContextPressure({
        usage: { usedTokens: 90_000, maxTokens: 900_000 },
        model: 'claude-sonnet-4-5',
        config: CONFIG
      })
    ).toMatchObject({ limitTokens: 200_000, limitSource: 'model' })
  })

  it('reports model metadata when an equal soft cap does not lower the limit', () => {
    expect(
      resolveContextPressure({
        usage: { usedTokens: 100_000 },
        model: 'claude-sonnet-4-5',
        agentType: 'claude',
        config: { ...CONFIG, softLimits: { 'model:claude-sonnet-4-5': 200_000 } }
      })
    ).toMatchObject({ limitTokens: 200_000, limitSource: 'model' })
  })

  it('credits ties to provider data, not the soft cap', () => {
    const snapshot = resolveContextPressure({
      usage: { usedTokens: 10, maxTokens: 1000 },
      agentType: 'claude',
      config: { ...CONFIG, softLimits: { 'agent:claude': 1000 } }
    })
    expect(snapshot?.limitSource).toBe('provider')
  })

  it('keys soft limits by exact model id before agent type', () => {
    const config: ContextPressureConfig = {
      ...CONFIG,
      softLimits: { 'model:claude-opus-5': 400_000, 'agent:claude': 100_000 }
    }
    expect(
      resolveContextPressure({
        usage: { usedTokens: 50 },
        model: 'claude-opus-5',
        agentType: 'claude',
        config
      })
    ).toMatchObject({ limitTokens: 400_000, limitSource: 'soft-cap' })
    // No model-specific cap → the agent-type cap applies.
    expect(
      resolveContextPressure({
        usage: { usedTokens: 50 },
        model: 'claude-haiku-4-5',
        agentType: 'claude',
        config
      })
    ).toMatchObject({ limitTokens: 100_000, limitSource: 'soft-cap' })
  })

  it('selects the most specific model, provider, agent, then global soft cap', () => {
    const config: ContextPressureConfig = {
      ...CONFIG,
      softLimits: {
        global: 160_000,
        'provider:anthropic': 180_000,
        'agent:claude': 170_000,
        'model:claude-opus-4-6': 120_000
      }
    }
    const usage = { usedTokens: 10, providerId: 'anthropic' }
    expect(
      resolveContextPressure({
        usage,
        model: 'claude-opus-4-6-20260514',
        agentType: 'claude',
        config
      })
    ).toMatchObject({ limitTokens: 120_000, limitSource: 'soft-cap' })
    expect(
      resolveContextPressure({ usage, model: 'claude-haiku-4-5', agentType: 'claude', config })
    ).toMatchObject({ limitTokens: 180_000, limitSource: 'soft-cap' })
    expect(
      resolveContextPressure({ usage: { usedTokens: 10 }, agentType: 'claude', config })
    ).toMatchObject({ limitTokens: 170_000, limitSource: 'soft-cap' })
    expect(resolveContextPressure({ usage: { usedTokens: 10 }, config })).toMatchObject({
      limitTokens: 160_000,
      limitSource: 'soft-cap'
    })
  })

  it('ignores unprefixed keys that bypassed sanitation instead of guessing their scope', () => {
    // Both unprefixed caps are skipped, so the model table binds instead of a 500/600 soft cap.
    expect(
      resolveContextPressure({
        usage: { usedTokens: 10 },
        model: 'claude-opus-5',
        agentType: 'claude',
        config: { ...CONFIG, softLimits: { 'claude-opus-5': 500, claude: 600 } }
      })
    ).toMatchObject({ limitSource: 'model' })
  })

  it('matches normalized model families on boundaries and uses the longest match', () => {
    const config: ContextPressureConfig = {
      ...CONFIG,
      softLimits: { 'model:claude-opus-4': 150_000, 'model:Claude-Opus-4.6': 120_000 }
    }
    expect(
      resolveContextPressure({
        usage: { usedTokens: 10 },
        model: 'claude-opus-4-6-thinking',
        config
      })
    ).toMatchObject({ limitTokens: 120_000 })
    expect(
      resolveContextPressure({ usage: { usedTokens: 10 }, model: 'claude-opus-40', config })
    ).toBeNull()
  })

  it('returns null when usage or any resolvable limit is missing (no invented values)', () => {
    expect(resolveContextPressure({ usage: undefined, config: CONFIG })).toBeNull()
    expect(resolveContextPressure({ usage: null, config: CONFIG })).toBeNull()
    // Unknown provider model, no provider max, no soft cap → no honest limit.
    expect(
      resolveContextPressure({
        usage: { usedTokens: 5000 },
        model: 'gemini-2.5-pro',
        agentType: 'gemini',
        config: CONFIG
      })
    ).toBeNull()
    expect(resolveContextPressure({ usage: { usedTokens: 5000 }, config: CONFIG })).toBeNull()
    expect(
      resolveContextPressure({
        usage: { usedTokens: Number.NaN },
        model: 'claude-opus-5',
        config: CONFIG
      })
    ).toBeNull()
  })

  it('treats inverted thresholds as criticalPercent = max(warn, critical)', () => {
    const inverted: ContextPressureConfig = { warnPercent: 90, criticalPercent: 70 }
    const at = (usedTokens: number) =>
      resolveContextPressure({ usage: { usedTokens, maxTokens: 100 }, config: inverted })
    expect(at(80)?.level).toBe('ok')
    // 90 is both warn and effective critical — critical wins.
    expect(at(90)?.level).toBe('critical')
  })

  it('substitutes defaults for non-finite thresholds', () => {
    const snapshot = resolveContextPressure({
      usage: { usedTokens: 75, maxTokens: 100 },
      config: { warnPercent: Number.NaN, criticalPercent: Number.POSITIVE_INFINITY }
    })
    // Defaults 70/90 → 75% is warning.
    expect(snapshot?.level).toBe('warning')
  })

  it('ignores non-positive provider max and soft caps instead of dividing by them', () => {
    expect(
      resolveContextPressure({
        usage: { usedTokens: 10, maxTokens: 0 },
        config: CONFIG
      })
    ).toBeNull()
    expect(
      resolveContextPressure({
        usage: { usedTokens: 10 },
        agentType: 'claude',
        config: { ...CONFIG, softLimits: { 'agent:claude': 0 } }
      })
    ).toBeNull()
  })
})

describe('normalizeContextPressurePercent', () => {
  it('rounds and clamps finite values into 1–100', () => {
    expect(normalizeContextPressurePercent(70.4, 90)).toBe(70)
    expect(normalizeContextPressurePercent(0, 90)).toBe(1)
    expect(normalizeContextPressurePercent(-5, 90)).toBe(1)
    expect(normalizeContextPressurePercent(250, 90)).toBe(100)
  })

  it('falls back for non-finite and non-number values', () => {
    expect(normalizeContextPressurePercent(Number.NaN, 90)).toBe(90)
    expect(normalizeContextPressurePercent('70', 90)).toBe(90)
    expect(normalizeContextPressurePercent(undefined, 70)).toBe(70)
  })
})

describe('normalizeContextPressureSoftLimits', () => {
  it('keeps positive finite caps as clamped integers and drops invalid entries', () => {
    expect(
      normalizeContextPressureSoftLimits({
        'model:claude-opus-5': 400_000.9,
        '  agent:claude  ': 100_000,
        'agent:codex': -1,
        'agent:gemini': Number.NaN,
        'agent:amp': '5',
        '': 10,
        'model:oversized': AGENT_CONTEXT_USAGE_MAX_TOKENS * 2
      })
    ).toEqual({
      'model:claude-opus-5': 400_000,
      'agent:claude': 100_000,
      'model:oversized': AGENT_CONTEXT_USAGE_MAX_TOKENS
    })
  })

  it('drops unprefixed and unknown-scope keys — every cap needs an explicit scope', () => {
    expect(
      normalizeContextPressureSoftLimits({
        claude: 100_000,
        'claude-opus-5': 200_000,
        'window:foo': 300_000,
        'model:': 400_000,
        global: 150_000
      })
    ).toEqual({ global: 150_000 })
  })

  it('bounds key length and entry count', () => {
    const longKey = `model:${'k'.repeat(CONTEXT_PRESSURE_SOFT_LIMIT_KEY_MAX_LENGTH)}`
    expect(normalizeContextPressureSoftLimits({ [longKey]: 10 })).toEqual({})

    const oversized = Object.fromEntries(
      Array.from({ length: CONTEXT_PRESSURE_SOFT_LIMIT_MAX_ENTRIES + 10 }, (_, i) => [
        `model:m-${i}`,
        1000
      ])
    )
    expect(Object.keys(normalizeContextPressureSoftLimits(oversized))).toHaveLength(
      CONTEXT_PRESSURE_SOFT_LIMIT_MAX_ENTRIES
    )
  })

  it('returns an empty record for non-object input', () => {
    expect(normalizeContextPressureSoftLimits(undefined)).toEqual({})
    expect(normalizeContextPressureSoftLimits(null)).toEqual({})
    expect(normalizeContextPressureSoftLimits([1, 2])).toEqual({})
    expect(normalizeContextPressureSoftLimits('claude=1')).toEqual({})
  })
})

describe('normalizeAgentContextUsage', () => {
  it('passes through the tri-state semantics: undefined = no update, null = clear', () => {
    expect(normalizeAgentContextUsage(undefined)).toBeUndefined()
    expect(normalizeAgentContextUsage(null)).toBeNull()
  })

  it('accepts valid readings, flooring to integers', () => {
    expect(normalizeAgentContextUsage({ usedTokens: 1234.7, maxTokens: 200_000.2 })).toEqual({
      usedTokens: 1234,
      maxTokens: 200_000
    })
    expect(normalizeAgentContextUsage({ usedTokens: 0 })).toEqual({ usedTokens: 0 })
  })

  it('normalizes provenance and explicit provider identity', () => {
    expect(
      normalizeAgentContextUsage({
        usedTokens: 100,
        usedTokensSource: 'derived-percent',
        providerId: ' Anthropic '
      })
    ).toEqual({ usedTokens: 100, usedTokensSource: 'derived-percent', providerId: 'anthropic' })
  })

  it('caps token counts at AGENT_CONTEXT_USAGE_MAX_TOKENS', () => {
    expect(
      normalizeAgentContextUsage({ usedTokens: Number.MAX_SAFE_INTEGER, maxTokens: 1e18 })
    ).toEqual({
      usedTokens: AGENT_CONTEXT_USAGE_MAX_TOKENS,
      maxTokens: AGENT_CONTEXT_USAGE_MAX_TOKENS
    })
  })

  it('drops invalid usedTokens entirely (undefined, not a guessed value)', () => {
    expect(normalizeAgentContextUsage({ usedTokens: -1 })).toBeUndefined()
    expect(normalizeAgentContextUsage({ usedTokens: Number.NaN })).toBeUndefined()
    expect(normalizeAgentContextUsage({ usedTokens: '42' })).toBeUndefined()
    expect(normalizeAgentContextUsage({})).toBeUndefined()
    expect(normalizeAgentContextUsage('usage')).toBeUndefined()
    expect(normalizeAgentContextUsage([{ usedTokens: 1 }])).toBeUndefined()
  })

  it('drops only maxTokens when it alone is invalid', () => {
    expect(normalizeAgentContextUsage({ usedTokens: 10, maxTokens: 0 })).toEqual({ usedTokens: 10 })
    expect(normalizeAgentContextUsage({ usedTokens: 10, maxTokens: -5 })).toEqual({
      usedTokens: 10
    })
    expect(normalizeAgentContextUsage({ usedTokens: 10, maxTokens: Number.NaN })).toEqual({
      usedTokens: 10
    })
  })
})

describe('agentContextUsageEqual', () => {
  it('compares structurally and treats null/undefined both as "no data"', () => {
    expect(agentContextUsageEqual(undefined, undefined)).toBe(true)
    expect(agentContextUsageEqual(null, undefined)).toBe(true)
    expect(agentContextUsageEqual({ usedTokens: 1 }, { usedTokens: 1 })).toBe(true)
    expect(
      agentContextUsageEqual({ usedTokens: 1, maxTokens: 2 }, { usedTokens: 1, maxTokens: 2 })
    ).toBe(true)
    expect(agentContextUsageEqual({ usedTokens: 1 }, { usedTokens: 2 })).toBe(false)
    expect(agentContextUsageEqual({ usedTokens: 1 }, { usedTokens: 1, maxTokens: 2 })).toBe(false)
    expect(agentContextUsageEqual({ usedTokens: 1 }, null)).toBe(false)
    expect(agentContextUsageEqual(undefined, { usedTokens: 1 })).toBe(false)
    expect(
      agentContextUsageEqual(
        { usedTokens: 1, usedTokensSource: 'provider' },
        { usedTokens: 1, usedTokensSource: 'derived-percent' }
      )
    ).toBe(false)
  })
})
