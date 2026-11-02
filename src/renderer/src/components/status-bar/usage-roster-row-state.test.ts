import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replace(`{{${name}}}`, value),
      fallback
    )
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

describe('inactive account usage preview', () => {
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
    ).toEqual({ kind: 'message', label: 'Updates when Claude runs' })
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

  it('treats a bare No credentials preview as signed out', () => {
    expect(
      getUsageRosterRowState(provider({ status: 'error', error: 'No credentials' }), false)
    ).toEqual({ kind: 'sign-in', statusLabel: 'not signed in' })
    expect(
      previewInactiveAccountUsage({
        isFetching: false,
        rateLimits: provider({ status: 'error', error: 'No credentials' })
      })
    ).toMatchObject({ kind: 'sign-in', label: 'not signed in' })
  })
})
