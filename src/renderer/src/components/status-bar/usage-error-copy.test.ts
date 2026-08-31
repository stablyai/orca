import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import {
  getProviderDisplayName,
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel
} from './usage-error-copy'

describe('getProviderDisplayName', () => {
  it('returns the Antigravity brand name', () => {
    expect(getProviderDisplayName('antigravity')).toBe('Antigravity')
  })

  it('returns the MiniMax brand name', () => {
    expect(getProviderDisplayName('minimax')).toBe('MiniMax')
  })

  it('returns the Cursor brand name', () => {
    expect(getProviderDisplayName('cursor')).toBe('Cursor')
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
/** Minimal Cursor provider fixture for usage-error copy tests. */
function cursorProvider(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'cursor',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: 'Cursor usage unavailable',
    status: 'error',
    ...overrides
  }
}

describe('Cursor usage error copy', () => {
  it('shows sign-in copy for missing Cursor credentials', () => {
    const p = cursorProvider({ usageMetadata: { failureKind: 'missing-credentials' } })

    expect(getProviderUsageStatusLabel(p)).toBe('Sign in required')
    expect(getProviderUsageErrorMessage(p)).toBe(
      'Sign in to Cursor from cursor-agent or the Cursor IDE, then retry usage.'
    )
  })

  it('shows sign-in copy for a stale Cursor token', () => {
    const p = cursorProvider({ usageMetadata: { failureKind: 'stale-token' } })

    expect(getProviderUsageStatusLabel(p)).toBe('Sign in required')
    expect(getProviderUsageErrorMessage(p)).toBe(
      'Cursor sign-in expired. Sign in again from cursor-agent or the Cursor IDE, then retry usage.'
    )
  })
})
