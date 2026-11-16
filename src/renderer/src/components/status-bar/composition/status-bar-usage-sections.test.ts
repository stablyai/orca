import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { getStatusBarUsageSections } from './status-bar-usage-sections'

function limits(
  provider: ProviderRateLimits['provider'],
  windows: Partial<ProviderRateLimits>
): ProviderRateLimits {
  return {
    provider,
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
    const [headline] = getStatusBarUsageSections(
      limits('claude', { fableWeekly: window(100) }),
      'compact'
    )
    expect(headline?.window.usedPercent).toBe(100)
  })

  it('picks the most-used window even when it is Fable', () => {
    const sections = getStatusBarUsageSections(
      limits('claude', { session: window(20), weekly: window(40), fableWeekly: window(95) }),
      'compact'
    )
    expect(sections.map((section) => section.window.usedPercent)).toEqual([95])
  })
})

describe('getStatusBarUsageSections compact label order', () => {
  it('puts a named pool label first, like Detailed', () => {
    const [headline] = getStatusBarUsageSections(
      limits('cursor', { buckets: [{ ...window(64), name: 'Cursor Models' }] }),
      'compact'
    )
    expect(headline?.labelFirst).toBe(true)
  })

  it('keeps time windows value first', () => {
    const [headline] = getStatusBarUsageSections(
      limits('claude', { session: window(30), weekly: window(10) }),
      'compact'
    )
    expect(headline?.labelFirst).toBe(false)
  })
})
