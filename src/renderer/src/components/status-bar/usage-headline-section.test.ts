import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { getTightestUsageSection, getUsageHeadlineSection } from './UsageRosterPanel'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

function windowOf(usedPercent: number, windowMinutes: number): RateLimitWindow {
  return { usedPercent, windowMinutes, resetsAt: null, resetDescription: null }
}

function claude(windows: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'ok',
    ...windows
  }
}

describe('getUsageHeadlineSection', () => {
  it('headlines the tighter account-wide window when the Fable window is more consumed', () => {
    const weekly = windowOf(40, 10080)
    const p = claude({ session: windowOf(10, 300), weekly, fableWeekly: windowOf(90, 10080) })

    expect(getUsageHeadlineSection(p)?.window).toBe(weekly)
  })

  it('keeps the Fable window for urgency ranking', () => {
    const fableWeekly = windowOf(100, 10080)
    const p = claude({ session: windowOf(10, 300), weekly: windowOf(40, 10080), fableWeekly })

    expect(getTightestUsageSection(p)?.window).toBe(fableWeekly)
  })
})
