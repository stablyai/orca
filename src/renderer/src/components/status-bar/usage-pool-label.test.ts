import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitBucket } from '../../../../shared/rate-limit-types'
import {
  formatPoolShortLabel,
  formatStatusBarSectionLabel,
  formatPoolWindowLabel
} from './usage-pool-label'
import { getTightestUsageSection } from './UsageRosterPanel'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values: Record<string, string> = {}) =>
    Object.entries(values).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))
vi.mock('@/components/agent/icons/AgentIcon', () => ({
  AgentIcon: () => null
}))
vi.mock('@/hooks/useResetCountdownClock', () => ({ useResetCountdownClock: () => 0 }))
vi.mock('@/components/ui/dropdown-menu', () => ({ DropdownMenuItem: () => null }))
vi.mock('@/components/settings/form-controls/SettingsFormControls', () => ({
  SettingsSegmentedControl: () => null
}))

const FIVE_HOURS = 300
const WEEK = 10_080

function pool(
  group: string | undefined,
  windowMinutes: number,
  overrides: Partial<RateLimitBucket> = {}
): RateLimitBucket {
  const windowName = windowMinutes === FIVE_HOURS ? '5h Limit Remaining' : 'Weekly Limit Remaining'
  return {
    name: group ? `${group} · ${windowName}` : 'Pro',
    ...(group ? { group, windowName } : {}),
    usedPercent: 0,
    windowMinutes,
    resetsAt: null,
    resetDescription: null,
    ...overrides
  }
}

describe('pool labels', () => {
  it('keeps full group names when two groups shorten to the same text', () => {
    const buckets = [pool('Gemini Models', WEEK), pool('Gemini models', WEEK)]
    expect(buckets.map((b) => formatPoolShortLabel(b, buckets))).toEqual([
      'Gemini Models wk',
      'Gemini models wk'
    ])
  })

  it('does not shorten another group to a name retained after a collision', () => {
    const buckets = [
      pool('Gemini Models', WEEK),
      pool('Gemini models', WEEK),
      pool('Gemini Models Models', WEEK)
    ]
    expect(buckets.map((bucket) => formatPoolShortLabel(bucket, buckets))).toEqual([
      'Gemini Models wk',
      'Gemini models wk',
      'Gemini Models Models wk'
    ])
  })

  it('keeps the full name for a pool with no group (an old host)', () => {
    const legacy = pool(undefined, WEEK, { name: 'Gemini Models · Weekly Limit Remaining' })
    expect(formatPoolShortLabel(legacy, [legacy])).toBe('Gemini Models · Weekly Limit Remaining')
  })

  it('adds a reset countdown only once a pool is urgent and its reset is known', () => {
    const now = Date.UTC(2026, 9, 1, 12)
    const resetsAt = now + 130 * 60_000
    const label = (overrides: Partial<RateLimitBucket>): string => {
      const bucket = pool('Gemini Models', FIVE_HOURS, overrides)
      return formatPoolWindowLabel(bucket, now)
    }

    expect(label({ usedPercent: 80, resetsAt })).toBe('5h (2h 10m)')
    expect(label({ usedPercent: 79, resetsAt })).toBe('5h')
    expect(label({ usedPercent: 80, resetsAt: null })).toBe('5h')
  })
})

describe('formatStatusBarSectionLabel', () => {
  it('labels a tie with the pool, not the derived weekly section', () => {
    const buckets = [
      pool('Gemini Models', FIVE_HOURS, { usedPercent: 30 }),
      pool('Gemini Models', WEEK, { usedPercent: 50 }),
      pool('Claude and GPT models', WEEK, { usedPercent: 10 })
    ]
    const p: ProviderRateLimits = {
      provider: 'antigravity',
      session: null,
      // Derived from the pools, so it ties with the Gemini weekly pool.
      weekly: { usedPercent: 50, windowMinutes: WEEK, resetsAt: null, resetDescription: null },
      buckets,
      updatedAt: 0,
      error: null,
      status: 'ok'
    }

    const tightest = getTightestUsageSection(p)
    expect(tightest?.window).toBe(buckets[1])
    expect(formatStatusBarSectionLabel(p, tightest!)).toBe('Gemini wk')
  })
})
