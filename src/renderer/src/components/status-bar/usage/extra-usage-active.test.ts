import { describe, expect, it } from 'vitest'
import { isExtraUsageActive } from './extra-usage-active'
import type {
  ExtraUsageBalance,
  ProviderRateLimits
} from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'

const credits: ExtraUsageBalance = {
  unit: 'credits',
  balance: 5,
  unlimited: false,
  enabled: true,
  disabledReason: null,
  resetsAt: null
}

function provider(
  id: ProviderRateLimits['provider'],
  extraUsage: ExtraUsageBalance | null,
  sessionUsed?: number
): ProviderRateLimits {
  return {
    provider: id,
    session:
      sessionUsed === undefined
        ? null
        : { usedPercent: sessionUsed, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    monthly: null,
    updatedAt: 1,
    error: null,
    status: 'ok',
    extraUsage
  }
}

describe('isExtraUsageActive', () => {
  it('shows a Command Code credit balance without a capped window', () => {
    expect(isExtraUsageActive(provider('command-code', credits, 10))).toBe(true)
  })

  it('hides a disabled Command Code balance', () => {
    expect(isExtraUsageActive(provider('command-code', { ...credits, enabled: false }, 10))).toBe(
      false
    )
  })

  it('keeps other providers gated on a capped window', () => {
    expect(isExtraUsageActive(provider('codex', credits, 50))).toBe(false)
    expect(isExtraUsageActive(provider('codex', credits, 100))).toBe(true)
  })
})
