/**
 * Issue #8974 — Claude usage stuck on "Refreshing sign-in".
 *
 * Transient failureKinds map to soft "Refreshing sign-in" copy while repair is
 * in flight. Once `refreshingSinceMs` ages past the escalate window, the UI
 * must leave the indefinite spinner and surface re-auth copy / CTA.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/status-bar/repro-8974-refreshing-sign-in-stuck.test.ts
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import {
  CLAUDE_REFRESHING_SIGN_IN_ESCALATE_AFTER_MS,
  stampClaudeRefreshingSince
} from '../../../../shared/claude-refreshing-sign-in'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { getProviderUsageErrorMessage, getProviderUsageStatusLabel } from './usage-error-copy'
import { getUsageRosterRowState } from './usage-roster-row-state'

function claudeError(failureKind: string, refreshingSinceMs?: number): ProviderRateLimits {
  return {
    provider: 'claude',
    status: 'error',
    error: 'token expired',
    updatedAt: Date.now(),
    session: null,
    weekly: null,
    monthly: null,
    usageMetadata: {
      failureKind: failureKind as never,
      ...(refreshingSinceMs != null ? { refreshingSinceMs } : {})
    }
  }
}

describe('issue #8974 Refreshing sign-in escalation', () => {
  it('maps auth-refresh failureKinds to Refreshing sign-in while the window is open', () => {
    const now = Date.now()
    for (const kind of [
      'stale-token',
      'refreshable-credentials-without-token',
      'delegated-refresh-required'
    ]) {
      const p = claudeError(kind, now)
      expect(getProviderUsageStatusLabel(p)).toBe('Refreshing sign-in')
      expect(getProviderUsageErrorMessage(p)).toMatch(/sign-in is being refreshed/i)
      expect(getUsageRosterRowState(p, false)).toEqual({
        kind: 'error',
        statusLabel: 'Refreshing sign-in'
      })
    }
  })

  it('escalates copy and roster CTA once refreshingSinceMs ages out', () => {
    const since = Date.now() - CLAUDE_REFRESHING_SIGN_IN_ESCALATE_AFTER_MS
    const p = claudeError('stale-token', since)

    expect(getProviderUsageStatusLabel(p)).toBe('Sign-in needs refresh')
    expect(getProviderUsageErrorMessage(p)).toMatch(/could not be refreshed/i)
    expect(getUsageRosterRowState(p, false)).toEqual({
      kind: 'sign-in',
      statusLabel: 'Sign-in needs refresh'
    })
  })

  it('preserves the first refresh stamp so continuous polls can escalate', () => {
    // Keep the synthetic clock near Date.now() so label helpers (which read wall clock) stay in-window.
    const t0 = Date.now() - 90_000
    let state = stampClaudeRefreshingSince(claudeError('stale-token'), null, t0)
    for (let i = 1; i <= 5; i++) {
      state = stampClaudeRefreshingSince(
        claudeError(i % 2 === 0 ? 'stale-token' : 'refreshable-credentials-without-token'),
        state,
        t0 + i * 5_000
      )
    }
    expect(state.usageMetadata?.refreshingSinceMs).toBe(t0)
    // ~90s + 25s still under the 2-minute escalate window.
    expect(getProviderUsageStatusLabel(state)).toBe('Refreshing sign-in')

    const escalated = claudeError(
      'stale-token',
      Date.now() - CLAUDE_REFRESHING_SIGN_IN_ESCALATE_AFTER_MS
    )
    expect(getProviderUsageStatusLabel(escalated)).toBe('Sign-in needs refresh')
  })
})
