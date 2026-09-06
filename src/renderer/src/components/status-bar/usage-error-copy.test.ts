import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { getProviderDisplayName, getProviderUsageErrorMessage } from './usage-error-copy'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

describe('getProviderDisplayName', () => {
  it('returns the Antigravity brand name', () => {
    expect(getProviderDisplayName('antigravity')).toBe('Antigravity')
  })

  it('returns the MiniMax brand name', () => {
    expect(getProviderDisplayName('minimax')).toBe('MiniMax')
  })

  it('returns the Z.AI brand name', () => {
    expect(getProviderDisplayName('zai')).toBe('Z.AI')
  })

  it('returns the existing provider brand names', () => {
    expect(getProviderDisplayName('claude')).toBe('Claude')
    expect(getProviderDisplayName('codex')).toBe('Codex')
    expect(getProviderDisplayName('gemini')).toBe('Gemini')
    expect(getProviderDisplayName('opencode-go')).toBe('OpenCode Go')
    expect(getProviderDisplayName('kimi')).toBe('Kimi')
    expect(getProviderDisplayName('grok')).toBe('Grok')
  })

  it('falls back to the raw provider id when no mapping exists', () => {
    // Why: provider id is a closed union, but TypeScript may not enforce
    // exhaustiveness on dynamic callers. Fallback keeps logging safe.
    expect(getProviderDisplayName('unknown-provider' as never)).toBe('unknown-provider')
  })
})

describe('getProviderUsageErrorMessage for Z.AI', () => {
  function zaiSnapshot(
    error: string | null,
    failureKind?: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind']
  ): ProviderRateLimits {
    return {
      provider: 'zai',
      session: null,
      weekly: null,
      updatedAt: 0,
      error,
      status: 'error',
      ...(failureKind ? { usageMetadata: { source: 'web', failureKind } } : {})
    }
  }

  it('instructs opencode auth login with the Z.AI Coding Plan on auth failures', () => {
    // Why: typed failure metadata must drive recovery even if backend copy changes.
    const message = getProviderUsageErrorMessage(zaiSnapshot('Credential rejected', 'stale-token'))

    expect(message).toContain('opencode auth login')
    expect(message).toContain('Z.AI Coding Plan')
  })

  it('passes non-auth Z.AI failures through untouched', () => {
    expect(getProviderUsageErrorMessage(zaiSnapshot('network request failed', 'network'))).toBe(
      'network request failed'
    )
  })
})
