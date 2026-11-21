/**
 * Issue #8974 — Claude usage stuck on "Refreshing sign-in".
 *
 * UI maps failureKind stale-token / refreshable-credentials-without-token /
 * delegated-refresh-required to permanent "Refreshing sign-in" copy with no
 * time-based escalation. Live Claude can keep working while usage OAuth is
 * stale; if repair never succeeds the chip never leaves refreshing.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/status-bar/repro-8974-refreshing-sign-in-stuck.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getProviderUsageErrorMessage, getProviderUsageStatusLabel } from './usage-error-copy'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

function claudeError(failureKind: string): ProviderRateLimits {
  return {
    provider: 'claude',
    status: 'error',
    error: 'token expired',
    updatedAt: Date.now(),
    session: null,
    weekly: null,
    monthly: null,
    usageMetadata: { failureKind: failureKind as never }
  } as ProviderRateLimits
}

describe('issue #8974 Refreshing sign-in has no recovery escalation in UI', () => {
  it('maps auth-refresh failureKinds to Refreshing sign-in indefinitely', () => {
    for (const kind of [
      'stale-token',
      'refreshable-credentials-without-token',
      'delegated-refresh-required'
    ]) {
      const p = claudeError(kind)
      expect(getProviderUsageStatusLabel(p)).toBe('Refreshing sign-in')
      expect(getProviderUsageErrorMessage(p)).toMatch(/sign-in is being refreshed/i)
    }
  })

  it('usage-error-copy has no age/timeout branch for refreshing kinds', () => {
    const source = readFileSync(join(__dirname, 'usage-error-copy.ts'), 'utf8')
    const refreshBlock = source.slice(
      source.indexOf("case 'stale-token'"),
      source.indexOf("case 'network'")
    )
    expect(refreshBlock).toMatch(/Refreshing sign-in/)
    expect(refreshBlock).not.toMatch(/updatedAt|Date\.now|timeout|escalat|STALE/)
  })

  it('main fetcher can emit deferred-by-live-session vs stale-token without UI progress clock', () => {
    const fetcher = readFileSync(
      join(__dirname, '../../../../main/rate-limits/claude-fetcher.ts'),
      'utf8'
    )
    expect(fetcher).toMatch(/failureKind: 'deferred-by-live-session'/)
    expect(fetcher).toMatch(/stale-token/)
    // No usage-metadata field that marks "refresh started at" for UI timeout.
    expect(fetcher).not.toMatch(/refreshStartedAt|refreshingSince/)
  })
})
