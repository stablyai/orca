import { describe, expect, it } from 'vitest'
import type { ClaudeCompactMetric } from '../../../../shared/claude-compact-metric'
import type {
  ProviderRateLimits,
  ProviderRateLimitStatus,
  RateLimitWindow
} from '../../../../shared/rate-limit-types'
import { getAvailableUsageSections, selectCompactUsage } from './compact-usage-selection'

function windowOf(usedPercent: number, windowMinutes: number): RateLimitWindow {
  return { usedPercent, windowMinutes, resetsAt: null, resetDescription: null }
}

function claudeLimits(
  overrides: Partial<ProviderRateLimits> = {},
  status: ProviderRateLimitStatus = 'ok'
): ProviderRateLimits {
  return {
    provider: 'claude',
    session: windowOf(3, 300),
    weekly: windowOf(97, 10_080),
    fableWeekly: windowOf(100, 10_080),
    updatedAt: 1,
    error: status === 'error' ? 'refresh failed' : null,
    status,
    ...overrides
  }
}

function selectedUsedPercent(provider: ProviderRateLimits, metric: ClaudeCompactMetric): number {
  const result = selectCompactUsage(provider, metric)
  if (result.kind !== 'selected') {
    throw new Error(`expected selected, received ${result.kind}`)
  }
  return result.section.window.usedPercent
}

describe('selectCompactUsage', () => {
  it.each([
    ['auto', 100],
    ['session', 3],
    ['weekly', 97],
    ['fableWeekly', 100]
  ] satisfies [ClaudeCompactMetric, number][])('selects %s exactly', (metric, usedPercent) => {
    expect(selectedUsedPercent(claudeLimits(), metric)).toBe(usedPercent)
  })

  it('preserves Automatic section order when consumed percentages tie', () => {
    const result = selectCompactUsage(
      claudeLimits({
        session: windowOf(50, 300),
        weekly: windowOf(50, 10_080),
        fableWeekly: windowOf(50, 10_080)
      }),
      'auto'
    )

    expect(result).toMatchObject({ kind: 'selected', section: { label: '5h' } })
  })

  it('keeps non-Claude providers on Automatic selection', () => {
    const provider: ProviderRateLimits = {
      ...claudeLimits(),
      provider: 'codex',
      session: windowOf(80, 300),
      weekly: windowOf(10, 10_080),
      fableWeekly: undefined
    }

    expect(selectedUsedPercent(provider, 'weekly')).toBe(80)
  })

  it.each(['ok', 'fetching', 'error'] as const)(
    'distinguishes a missing explicit metric from provider health in %s state',
    (status) => {
      expect(selectCompactUsage(claudeLimits({ weekly: null }, status), 'weekly')).toEqual({
        kind: 'unavailable',
        metric: 'weekly',
        label: 'Weekly'
      })
    }
  )

  it('treats an undefined explicit window as unavailable when other data exists', () => {
    const provider = claudeLimits()
    Reflect.deleteProperty(provider, 'weekly')

    expect(selectCompactUsage(provider, 'weekly')).toMatchObject({
      kind: 'unavailable',
      metric: 'weekly'
    })
    expect(
      getAvailableUsageSections(provider).map((section) => section.window.usedPercent)
    ).toEqual([3, 100])
  })

  it('returns empty for Automatic when Claude has no usage data', () => {
    expect(
      selectCompactUsage(claudeLimits({ session: null, weekly: null, fableWeekly: null }), 'auto')
    ).toEqual({ kind: 'empty' })
  })

  it.each(['session', 'weekly', 'fableWeekly'] as const)(
    'keeps an explicit %s choice unavailable when all Claude windows are absent',
    (metric) => {
      expect(
        selectCompactUsage(claudeLimits({ session: null, weekly: null, fableWeekly: null }), metric)
      ).toMatchObject({ kind: 'unavailable', metric })
    }
  )

  it('recovers the saved explicit choice when its data returns', () => {
    const unavailable = selectCompactUsage(claudeLimits({ weekly: null }), 'weekly')
    const recovered = selectCompactUsage(claudeLimits({ weekly: windowOf(42, 10_080) }), 'weekly')

    expect(unavailable.kind).toBe('unavailable')
    expect(recovered).toMatchObject({
      kind: 'selected',
      section: { window: { usedPercent: 42 } }
    })
  })
})
