import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { getUsageRosterRowState } from './usage-roster-row-state'

function provider(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('getUsageRosterRowState', () => {
  it('keeps fetching providers in a loading state instead of calling them signed out', () => {
    expect(getUsageRosterRowState(provider({ status: 'fetching' }), false)).toEqual({
      kind: 'loading',
      statusLabel: 'Loading usage…'
    })
  })

  it('preserves transient Claude failure copy instead of offering sign-in', () => {
    expect(
      getUsageRosterRowState(
        provider({
          status: 'error',
          error: 'OAuth token is stale',
          usageMetadata: { failureKind: 'stale-token' }
        }),
        false
      )
    ).toEqual({ kind: 'error', statusLabel: 'Refreshing sign-in' })
    expect(
      getUsageRosterRowState(
        provider({
          status: 'error',
          error: 'network unavailable',
          usageMetadata: { failureKind: 'network' }
        }),
        false
      )
    ).toEqual({ kind: 'error', statusLabel: 'Network issue' })
  })

  it('offers sign-in only for confirmed signed-out failures', () => {
    expect(
      getUsageRosterRowState(
        provider({ status: 'error', usageMetadata: { failureKind: 'missing-credentials' } }),
        false
      )
    ).toEqual({ kind: 'sign-in', statusLabel: 'not signed in' })
    expect(
      getUsageRosterRowState(
        provider({
          provider: 'codex',
          status: 'error',
          error: 'ChatGPT authentication required to read rate limits'
        }),
        false
      )
    ).toEqual({ kind: 'sign-in', statusLabel: 'not signed in' })
  })

  it('does not turn an expired CLI-owned Kimi token into a sign-in action', () => {
    expect(
      getUsageRosterRowState(
        provider({
          provider: 'kimi',
          status: 'error',
          error: 'Kimi token expired — open Kimi to refresh'
        }),
        false
      )
    ).toEqual({ kind: 'error', statusLabel: 'Refresh failed' })
  })

  it('distinguishes unavailable and empty successful responses', () => {
    expect(
      getUsageRosterRowState(
        provider({ status: 'unavailable', error: 'Claude CLI not found' }),
        false
      )
    ).toEqual({ kind: 'unavailable', statusLabel: 'Usage unavailable' })
    expect(getUsageRosterRowState(provider(), false)).toEqual({
      kind: 'empty',
      statusLabel: 'No usage data'
    })
  })

  it('lets real usage data win over a stale error status', () => {
    expect(getUsageRosterRowState(provider({ status: 'error' }), true)).toEqual({
      kind: 'usage',
      statusLabel: null
    })
  })
})
