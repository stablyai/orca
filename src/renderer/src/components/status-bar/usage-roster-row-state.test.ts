import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import {
  getUsageRosterRowState,
  previewAccountRowUsage,
  previewInactiveAccountUsage
} from './usage-roster-row-state'

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

  it('treats an invalidated Codex login as signed out and leaves other probe errors alone', () => {
    expect(
      getUsageRosterRowState(
        provider({
          provider: 'codex',
          status: 'error',
          error: 'Your authentication token has been invalidated. Please try signing in again.'
        }),
        false
      ).kind
    ).toBe('sign-in')
    expect(
      getUsageRosterRowState(
        provider({ provider: 'codex', status: 'error', error: 'RPC failed' }),
        false
      )
    ).toEqual({ kind: 'error', statusLabel: 'Refresh failed' })
  })

  it('paints the header windows on the active row, including a weekly-only Codex login', () => {
    const header = provider({
      session: { usedPercent: 16, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: { usedPercent: 20, windowMinutes: 10080, resetsAt: null, resetDescription: null },
      fableWeekly: { usedPercent: 0, windowMinutes: 10080, resetsAt: null, resetDescription: null }
    })
    const active = previewAccountRowUsage({ active: true, activeLimits: header, inactive: null })
    expect(active.kind).toBe('usage')
    if (active.kind === 'usage') {
      expect(active.limits.session?.usedPercent).toBe(16)
      expect(active.limits.weekly?.usedPercent).toBe(20)
      expect(active.limits.fableWeekly?.usedPercent).toBe(0)
    }
    expect(
      previewAccountRowUsage({ active: false, activeLimits: header, inactive: null }).kind
    ).toBe('empty')
    expect(
      previewAccountRowUsage({
        active: true,
        activeLimits: provider({
          provider: 'codex',
          weekly: { usedPercent: 65, windowMinutes: 10080, resetsAt: null, resetDescription: null }
        }),
        inactive: null
      }).kind
    ).toBe('usage')
  })

  it('shows a status line for an inactive account whose usage read failed', () => {
    expect(
      previewInactiveAccountUsage({
        isFetching: false,
        rateLimits: provider({
          status: 'error',
          error: 'OAuth access token has expired',
          usageMetadata: { failureKind: 'stale-token' }
        })
      })
    ).toEqual({ kind: 'message', label: 'Refreshing sign-in' })
    expect(
      previewInactiveAccountUsage({
        isFetching: false,
        rateLimits: provider({
          status: 'ok',
          session: {
            usedPercent: 16,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          },
          weekly: {
            usedPercent: 20,
            windowMinutes: 10080,
            resetsAt: null,
            resetDescription: null
          }
        })
      }).kind
    ).toBe('usage')
  })

  it('offers sign-in only for confirmed signed-out failures', () => {
    expect(
      getUsageRosterRowState(provider({ status: 'error', error: 'No credentials' }), false)
    ).toEqual({ kind: 'error', statusLabel: 'Refresh failed' })
    expect(
      previewInactiveAccountUsage({
        isFetching: false,
        rateLimits: provider({
          status: 'error',
          error: 'No credentials',
          usageMetadata: { failureKind: 'missing-credentials' }
        })
      })
    ).toMatchObject({ kind: 'sign-in', label: 'not signed in' })
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
