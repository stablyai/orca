import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { getUsageUnitLabelState, usageChipShowsPercentage } from './usage-unit-label'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('@/hooks/useResetCountdownClock', () => ({ useResetCountdownClock: () => 0 }))
vi.mock('@/components/ui/dropdown-menu', () => ({ DropdownMenuItem: () => null }))
vi.mock('@/components/settings/SettingsFormControls', () => ({
  SettingsSegmentedControl: () => null
}))

function windowOf(usedPercent: number): RateLimitWindow {
  return { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null }
}

function limits(
  provider: ProviderRateLimits['provider'],
  status: ProviderRateLimits['status'],
  session: RateLimitWindow | null = null
): ProviderRateLimits {
  return { provider, session, weekly: null, updatedAt: 0, error: null, status }
}

describe('usageChipShowsPercentage', () => {
  it('is false for chips that render no percentage', () => {
    expect(usageChipShowsPercentage(null, 'verbose')).toBe(false)
    expect(usageChipShowsPercentage(limits('claude', 'idle', windowOf(5)), 'verbose')).toBe(false)
    expect(usageChipShowsPercentage(limits('claude', 'unavailable'), 'verbose')).toBe(false)
    expect(usageChipShowsPercentage(limits('claude', 'error'), 'verbose')).toBe(false)
    expect(usageChipShowsPercentage(limits('claude', 'fetching'), 'compact')).toBe(false)
  })

  it('is true for an error that still has stale data', () => {
    expect(usageChipShowsPercentage(limits('codex', 'error', windowOf(40)), 'verbose')).toBe(true)
  })

  it('follows the verbose bucket filter, which compact mode bypasses', () => {
    const gemini: ProviderRateLimits = {
      ...limits('gemini', 'ok'),
      buckets: [{ ...windowOf(30), name: 'Experimental' }]
    }
    expect(usageChipShowsPercentage(gemini, 'verbose')).toBe(false)
    expect(usageChipShowsPercentage(gemini, 'compact')).toBe(true)
    expect(usageChipShowsPercentage({ ...gemini, weekly: windowOf(10) }, 'verbose')).toBe(true)
  })
})

describe('getUsageUnitLabelState', () => {
  it('shows the label when a later chip has a percentage and the first is in error', () => {
    const providers = [limits('codex', 'error'), limits('gemini', 'ok', windowOf(0))]
    expect(getUsageUnitLabelState(providers, [], 'verbose')).toBe('shown')
  })

  it('is absent when no chip shows a percentage', () => {
    const providers = [
      limits('claude', 'idle'),
      limits('codex', 'unavailable'),
      limits('gemini', 'error')
    ]
    expect(getUsageUnitLabelState(providers, [], 'verbose')).toBe('absent')
    expect(getUsageUnitLabelState([], [], 'compact')).toBe('absent')
  })

  it('collapses only when every chip with a percentage is folded', () => {
    const providers = [
      limits('codex', 'error'),
      limits('gemini', 'ok', windowOf(10)),
      limits('claude', 'error', windowOf(20))
    ]
    expect(getUsageUnitLabelState(providers, ['gemini'], 'verbose')).toBe('shown')
    expect(getUsageUnitLabelState(providers, ['gemini', 'claude'], 'verbose')).toBe('collapsed')
    expect(getUsageUnitLabelState(providers, ['gemini', 'claude'], 'compact')).toBe('collapsed')
  })
})
