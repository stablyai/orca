import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitBucket } from '../../../../shared/rate-limit-types'
import {
  formatPoolShortLabel,
  formatStatusBarSectionLabel,
  formatPoolGroupLabel,
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
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('@/hooks/useResetCountdownClock', () => ({ useResetCountdownClock: () => 0 }))
vi.mock('@/components/ui/dropdown-menu', () => ({ DropdownMenuItem: () => null }))
vi.mock('@/components/settings/SettingsFormControls', () => ({
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

const TWO_GROUPS = [
  pool('Gemini Models', FIVE_HOURS),
  pool('Gemini Models', WEEK),
  pool('Claude and GPT models', FIVE_HOURS),
  pool('Claude and GPT models', WEEK)
]

describe('pool labels', () => {
  it('shortens two groups with two windows each', () => {
    expect(TWO_GROUPS.map((b) => formatPoolShortLabel(b, TWO_GROUPS))).toEqual([
      'Gemini 5h',
      'Gemini wk',
      'Claude/GPT 5h',
      'Claude/GPT wk'
    ])
    expect(formatPoolGroupLabel('Claude and GPT models', TWO_GROUPS)).toBe('Claude/GPT')
  })

  it('labels a single-window group by its window length', () => {
    const buckets = [pool('Gemini Models', WEEK, { name: 'Gemini Models' })]
    expect(formatPoolShortLabel(buckets[0], buckets)).toBe('Gemini wk')
  })

  it('uses agy’s window name without "Limit Remaining" for an unknown window', () => {
    const daily = pool('Gemini Models', 0, { windowName: 'Daily Limit Remaining' })
    expect(formatPoolShortLabel(daily, [daily])).toBe('Gemini Daily')
  })

  it('shows the group alone for an unknown window with no window name', () => {
    const { windowName: _windowName, ...unnamed } = pool('Gemini Models', 0)
    expect(formatPoolShortLabel(unnamed, [unnamed])).toBe('Gemini')
    expect(formatPoolWindowLabel(unnamed)).toBe('')
  })

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

  it('passes a group name the rule does not match through', () => {
    const buckets = [pool('Gemini Models', WEEK), pool('Gemini models (Preview)', WEEK)]
    expect(buckets.map((b) => formatPoolShortLabel(b, buckets))).toEqual([
      'Gemini wk',
      'Gemini models (Preview) wk'
    ])
  })

  it('keeps the full name for a pool with no group (an old host)', () => {
    const legacy = pool(undefined, WEEK, { name: 'Gemini Models · Weekly Limit Remaining' })
    expect(formatPoolShortLabel(legacy, [legacy])).toBe('Gemini Models · Weekly Limit Remaining')
  })

  it('leaves Gemini CLI’s 60-minute "Pro" pool unchanged', () => {
    const pro = pool(undefined, 60, { name: 'Pro' })
    expect(formatPoolShortLabel(pro, [pro])).toBe('Pro')
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

  it.each([
    [WEEK, 'Weekly Limit Remaining', 'wk (2h 10m)'],
    [0, 'Daily Limit Remaining', 'Daily (2h 10m)'],
    [0, undefined, '2h 10m']
  ] as const)(
    'keeps the window identity for an urgent %s-minute pool',
    (minutes, windowName, expected) => {
      const now = Date.UTC(2026, 9, 1, 12)
      const bucket = pool('Gemini Models', minutes, {
        windowName,
        usedPercent: 90,
        resetsAt: now + 130 * 60_000
      })

      expect(formatPoolWindowLabel(bucket, now)).toBe(expected)
    }
  )
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

  it('returns the section label when the window is not a grouped bucket', () => {
    const p: ProviderRateLimits = {
      provider: 'gemini',
      session: null,
      weekly: null,
      buckets: [pool(undefined, 60, { name: 'Pro', usedPercent: 40 })],
      updatedAt: 0,
      error: null,
      status: 'ok'
    }
    expect(formatStatusBarSectionLabel(p, getTightestUsageSection(p)!)).toBe('Pro')
  })
})
