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

function claudeError(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: 'Claude sign-in expired',
    status: 'error',
    usageMetadata: { failureKind: 'signed-out' },
    ...overrides
  }
}

describe('getProviderDisplayName', () => {
  it('returns the Antigravity brand name', () => {
    expect(getProviderDisplayName('antigravity')).toBe('Antigravity')
  })

  it('returns the MiniMax brand name', () => {
    expect(getProviderDisplayName('minimax')).toBe('MiniMax')
  })

  it('returns the existing provider brand names', () => {
    expect(getProviderDisplayName('claude')).toBe('Claude')
    expect(getProviderDisplayName('codex')).toBe('Codex')
    expect(getProviderDisplayName('gemini')).toBe('Gemini')
    expect(getProviderDisplayName('opencode-go')).toBe('OpenCode Go')
    expect(getProviderDisplayName('kimi')).toBe('Kimi')
    expect(getProviderDisplayName('grok')).toBe('Grok')
  })

  it('labels a signed-out Claude snapshot as not signed in', () => {
    expect(getProviderUsageStatusLabel(claudeError())).toBe('not signed in')
  })

  it('surfaces the signed-out message instead of generic auth copy', () => {
    expect(getProviderUsageErrorMessage(claudeError())).toBe('Claude sign-in expired')
  })

  it('falls back to the raw provider id when no mapping exists', () => {
    // Why: provider id is a closed union, but TypeScript may not enforce
    // exhaustiveness on dynamic callers. Fallback keeps logging safe.
    expect(getProviderDisplayName('unknown-provider' as never)).toBe('unknown-provider')
  })
})
