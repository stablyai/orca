import { describe, expect, it } from 'vitest'
import type {
  ProviderRateLimits,
  ProviderRateLimitStatus
} from '../../../../shared/rate-limit-types'
import { isProviderConfigured } from './status-bar-provider-visibility'

function provider(
  status: ProviderRateLimitStatus,
  overrides: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider: 'gemini',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status,
    ...overrides
  }
}

describe('isProviderConfigured', () => {
  it('hides a provider whose state has not loaded yet', () => {
    expect(isProviderConfigured(null)).toBe(false)
  })

  it('hides an unconfigured (unavailable) provider', () => {
    // The bug: Gemini OAuth off / OpenCode Go cookie unset returns a non-null
    // `unavailable` object, which previously slipped past the `!== null` gate
    // and rendered a "--" bar for a provider the user never configured.
    expect(isProviderConfigured(provider('unavailable'))).toBe(false)
  })

  it('hides a first-load fetching provider until it has proven usage data', () => {
    // The initial fetch marks every provider as `fetching`; without prior data
    // that state is not proof the user configured Gemini or OpenCode Go.
    expect(isProviderConfigured(provider('fetching'))).toBe(false)
  })

  it('shows configured providers, including ones failing transiently', () => {
    expect(isProviderConfigured(provider('ok'))).toBe(true)
    expect(isProviderConfigured(provider('error'))).toBe(true)
    expect(
      isProviderConfigured(
        provider('fetching', {
          session: {
            usedPercent: 25,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          }
        })
      )
    ).toBe(true)
    expect(isProviderConfigured(provider('idle'))).toBe(true)
  })
})
