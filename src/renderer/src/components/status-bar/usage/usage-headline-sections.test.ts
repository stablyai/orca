import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../../shared/rate-limit-types'

vi.mock('@/components/agent/icons/AgentIcon', () => ({ AgentIcon: () => null }))

const {
  getUrgentScopedSection,
  getUsageHeadlineSection,
  hasOnlyScopedUsage,
  providerPrimaryMaxUsed
} = await import('./usage-headline-sections')

function win(usedPercent: number, windowMinutes: number): RateLimitWindow {
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

describe('primary-only usage headline', () => {
  it('ignores a spent Fable window for the headline and sort, but flags it', () => {
    const weekly = win(33, 10_080)
    const p = claude({ session: win(12, 300), weekly, fableWeekly: win(100, 10_080) })
    expect(getUsageHeadlineSection(p)?.window).toBe(weekly)
    expect(providerPrimaryMaxUsed(p)).toBe(33)
    expect(getUrgentScopedSection(p)?.label).toBe('Fable')
  })

  it('has no headline when only Fable was read, instead of standing Fable in', () => {
    const p = claude({ fableWeekly: win(100, 10_080) })
    expect(getUsageHeadlineSection(p)).toBeNull()
    expect(hasOnlyScopedUsage(p)).toBe(true)
    expect(providerPrimaryMaxUsed(p)).toBe(-1)
  })

  it('treats the ZCode MCP limit as scoped', () => {
    const session = win(20, 300)
    const p: ProviderRateLimits = {
      provider: 'zcode',
      session,
      weekly: null,
      monthly: win(100, 43_200),
      updatedAt: 0,
      error: null,
      status: 'ok'
    }
    expect(getUsageHeadlineSection(p)?.window).toBe(session)
    expect(getUrgentScopedSection(p)?.window).toBe(p.monthly)
  })

  it('does not flag a scoped window below 90% used', () => {
    const p = claude({ weekly: win(50, 10_080), fableWeekly: win(89, 10_080) })
    expect(getUrgentScopedSection(p)).toBeNull()
  })
})
