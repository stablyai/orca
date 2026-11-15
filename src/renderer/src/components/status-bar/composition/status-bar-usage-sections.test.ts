import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getStatusBarUsageSections } from './status-bar-usage-sections'

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

const window = (usedPercent: number) => ({
  usedPercent,
  windowMinutes: 10_080,
  resetsAt: null,
  resetDescription: null
})

describe('getStatusBarUsageSections compact headline', () => {
  it('shows a Fable-only reading as the headline', () => {
    const [headline] = getStatusBarUsageSections(claude({ fableWeekly: window(100) }), 'compact')
    expect(headline?.window.usedPercent).toBe(100)
  })

  it('picks the most-used window even when it is Fable', () => {
    const sections = getStatusBarUsageSections(
      claude({ session: window(20), weekly: window(40), fableWeekly: window(95) }),
      'compact'
    )
    expect(sections.map((section) => section.window.usedPercent)).toEqual([95])
  })
})
