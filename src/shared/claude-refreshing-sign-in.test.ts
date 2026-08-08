import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from './rate-limit-types'
import {
  CLAUDE_REFRESHING_SIGN_IN_ESCALATE_AFTER_MS,
  isClaudeRefreshingSignInEscalated,
  stampClaudeRefreshingSince
} from './claude-refreshing-sign-in'

function claudeError(
  failureKind: string,
  overrides: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider: 'claude',
    status: 'error',
    error: 'token expired',
    updatedAt: Date.now(),
    session: null,
    weekly: null,
    monthly: null,
    usageMetadata: { failureKind: failureKind as never },
    ...overrides
  }
}

describe('stampClaudeRefreshingSince', () => {
  it('stamps refreshingSinceMs on first Claude refreshing failure', () => {
    const now = 1_700_000_000_000
    const stamped = stampClaudeRefreshingSince(claudeError('stale-token'), null, now)
    expect(stamped.usageMetadata?.refreshingSinceMs).toBe(now)
  })

  it('preserves the original stamp across continuous refreshing failures', () => {
    const first = 1_700_000_000_000
    const later = first + 30_000
    const previous = stampClaudeRefreshingSince(claudeError('stale-token'), null, first)
    const next = stampClaudeRefreshingSince(
      claudeError('refreshable-credentials-without-token'),
      previous,
      later
    )
    expect(next.usageMetadata?.refreshingSinceMs).toBe(first)
  })

  it('clears the stamp when usage recovers', () => {
    const previous = stampClaudeRefreshingSince(
      claudeError('stale-token'),
      null,
      1_700_000_000_000
    )
    const ok: ProviderRateLimits = {
      provider: 'claude',
      status: 'ok',
      error: null,
      updatedAt: Date.now(),
      session: { usedPercent: 10, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      usageMetadata: {
        source: 'oauth',
        refreshingSinceMs: previous.usageMetadata?.refreshingSinceMs
      }
    }
    const recovered = stampClaudeRefreshingSince(ok, previous)
    expect(recovered.usageMetadata?.refreshingSinceMs).toBeUndefined()
  })

  it('does not stamp non-Claude providers', () => {
    const p: ProviderRateLimits = {
      provider: 'codex',
      status: 'error',
      error: 'token expired',
      updatedAt: Date.now(),
      session: null,
      weekly: null,
      usageMetadata: { failureKind: 'stale-token' }
    }
    expect(stampClaudeRefreshingSince(p, null).usageMetadata?.refreshingSinceMs).toBeUndefined()
  })
})

describe('isClaudeRefreshingSignInEscalated', () => {
  it('is false while the refresh window is still open', () => {
    const since = 1_700_000_000_000
    const p = stampClaudeRefreshingSince(claudeError('stale-token'), null, since)
    expect(
      isClaudeRefreshingSignInEscalated(p, since + CLAUDE_REFRESHING_SIGN_IN_ESCALATE_AFTER_MS - 1)
    ).toBe(false)
  })

  it('is true once the refresh window ages out (#8974)', () => {
    const since = 1_700_000_000_000
    const p = stampClaudeRefreshingSince(claudeError('stale-token'), null, since)
    expect(
      isClaudeRefreshingSignInEscalated(p, since + CLAUDE_REFRESHING_SIGN_IN_ESCALATE_AFTER_MS)
    ).toBe(true)
  })
})
