import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  formatPickedUsageResets,
  keepOfferedPicks,
  listPickableUsageWindows,
  selectPickedUsageWindows
} from './status-bar-provider-usage'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const window = (usedPercent: number, windowMinutes: number, resetsAt: number | null = null) =>
  ({ usedPercent, windowMinutes, resetsAt, resetDescription: null }) satisfies RateLimitWindow

const limits = (overrides: Partial<ProviderRateLimits>): ProviderRateLimits => ({
  provider: 'claude',
  session: window(4, 300),
  weekly: window(68, 10_080),
  updatedAt: 1,
  error: null,
  status: 'ok',
  ...overrides
})

const antigravity = limits({
  provider: 'antigravity',
  session: window(99, 300),
  weekly: window(98, 10_080),
  buckets: [
    { name: 'Gemini Models · Weekly Limit Remaining', ...window(24, 10_080) },
    { name: 'Gemini Models · Five Hour Limit Remaining', ...window(13, 300) },
    { name: 'Claude and GPT models · Weekly Limit Remaining', ...window(98, 10_080) }
  ]
})

describe('selectPickedUsageWindows', () => {
  it('returns nothing without picks, so the default summary renders', () => {
    expect(selectPickedUsageWindows(limits({}), undefined)).toEqual([])
    expect(selectPickedUsageWindows(limits({}), [])).toEqual([])
  })

  it('orders Claude picks weekly, 5h, Fable with fixed window names', () => {
    const claude = limits({ fableWeekly: window(35, 10_080) })
    const picks = selectPickedUsageWindows(claude, ['fableWeekly', 'session', 'weekly'])
    expect(picks.map((pick) => [pick.label, pick.window.usedPercent])).toEqual([
      ['wk', 68],
      ['5h', 4],
      ['Fable', 35]
    ])
  })

  it('shows only the Codex weekly window when that is the pick', () => {
    const picks = selectPickedUsageWindows(limits({ provider: 'codex' }), ['weekly'])
    expect(picks.map((pick) => pick.key)).toEqual(['weekly'])
  })

  it('selects Gemini buckets by name and labels them with their group', () => {
    const picks = selectPickedUsageWindows(antigravity, [
      'bucket:Gemini Models · Five Hour Limit Remaining',
      'bucket:Gemini Models · Weekly Limit Remaining'
    ])
    expect(picks.map((pick) => [pick.group, pick.label, pick.window.usedPercent])).toEqual([
      ['Gemini Models', 'wk', 24],
      ['Gemini Models', '5h', 13]
    ])
  })

  it('skips picks the snapshot no longer reports', () => {
    expect(selectPickedUsageWindows(limits({}), ['fableWeekly', 'bucket:Gone', 'monthly'])).toEqual(
      []
    )
  })
})

describe('Antigravity aggregate windows', () => {
  it('names its derived session and weekly windows as the tightest group', () => {
    const picks = selectPickedUsageWindows(antigravity, ['weekly', 'session'])
    expect(picks.map((pick) => [pick.group, pick.label])).toEqual([
      ['Tightest', 'wk'],
      ['Tightest', '5h']
    ])
  })
})

describe('listPickableUsageWindows', () => {
  it('offers every reported window, including each Antigravity group', () => {
    expect(listPickableUsageWindows(antigravity).map((pick) => pick.key)).toEqual([
      'weekly',
      'session',
      'bucket:Gemini Models · Weekly Limit Remaining',
      'bucket:Gemini Models · Five Hour Limit Remaining',
      'bucket:Claude and GPT models · Weekly Limit Remaining'
    ])
  })
})

describe('keepOfferedPicks', () => {
  it('drops saved picks the provider no longer reports, so the next toggle clears them', () => {
    const offered = listPickableUsageWindows(antigravity)
    expect(
      keepOfferedPicks(
        ['bucket:Gemini Models · Weekly Limit Remaining', 'bucket:Retired group'],
        offered
      )
    ).toEqual(['bucket:Gemini Models · Weekly Limit Remaining'])
    expect(keepOfferedPicks(undefined, offered)).toEqual([])
  })
})

describe('formatPickedUsageResets', () => {
  it('lists the reset countdowns the window names leave out', () => {
    const now = 1_700_000_000_000
    const claude = limits({
      session: window(4, 300, now + (2 * 60 + 33) * 60_000),
      weekly: window(68, 10_080, null)
    })
    const picks = selectPickedUsageWindows(claude, ['weekly', 'session'])
    expect(formatPickedUsageResets(picks, now)).toBe('5h: Resets in 2h 33m')
  })
})
