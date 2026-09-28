import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { getInlineResetCreditCount } from './reset-credit-indicator'

function codexWith(resetCredits: ProviderRateLimits['rateLimitResetCredits']): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    rateLimitResetCredits: resetCredits,
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

describe('getInlineResetCreditCount', () => {
  it('returns the available count for a Codex provider with credits', () => {
    expect(getInlineResetCreditCount(codexWith({ availableCount: 2 }))).toBe(2)
  })

  it('returns null when no credits are available', () => {
    expect(getInlineResetCreditCount(codexWith({ availableCount: 0 }))).toBeNull()
    expect(getInlineResetCreditCount(codexWith(null))).toBeNull()
    expect(getInlineResetCreditCount(codexWith(undefined))).toBeNull()
  })

  it('ignores non-finite counts from partial data', () => {
    expect(getInlineResetCreditCount(codexWith({ availableCount: Number.NaN }))).toBeNull()
  })

  it('returns null for non-Codex providers and null input', () => {
    const claude: ProviderRateLimits = {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
    expect(getInlineResetCreditCount(claude)).toBeNull()
    expect(getInlineResetCreditCount(null)).toBeNull()
  })
})
