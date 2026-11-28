import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import { isUsageEmptyState } from './status-bar-provider-visibility'

function unavailable(provider: ProviderRateLimits['provider']): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'unavailable'
  }
}

const settledProviders = createEmptyRateLimitState({
  claude: unavailable('claude'),
  codex: unavailable('codex'),
  opencodeGo: unavailable('opencode-go'),
  kimi: unavailable('kimi'),
  minimax: unavailable('minimax'),
  grok: unavailable('grok'),
  cursor: unavailable('cursor'),
  zcode: unavailable('zcode'),
  muse: unavailable('muse')
})

describe('isUsageEmptyState Kimchi compatibility', () => {
  it('treats an older host without Kimchi as absent, not pending', () => {
    expect(isUsageEmptyState({ ...settledProviders, kimchi: null }, {})).toBe(true)
  })

  it('keeps a genuine Kimchi fetch pending', () => {
    expect(
      isUsageEmptyState(
        {
          ...settledProviders,
          kimchi: {
            ...unavailable('kimchi'),
            updatedAt: 0,
            status: 'fetching'
          }
        },
        {}
      )
    ).toBe(false)
  })
})
