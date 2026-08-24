import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

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

  it('returns the existing provider brand names', () => {
    expect(getProviderDisplayName('claude')).toBe('Claude')
    expect(getProviderDisplayName('codex')).toBe('Codex')
    expect(getProviderDisplayName('gemini')).toBe('Gemini')
    expect(getProviderDisplayName('opencode-go')).toBe('OpenCode Go')
    expect(getProviderDisplayName('kimi')).toBe('Kimi')
    expect(getProviderDisplayName('grok')).toBe('Grok')
    expect(getProviderDisplayName('cursor')).toBe('Cursor')
  })

  it('falls back to the raw provider id when no mapping exists', () => {
    // Why: provider id is a closed union, but TypeScript may not enforce
    // exhaustiveness on dynamic callers. Fallback keeps logging safe.
    expect(getProviderDisplayName('unknown-provider' as never)).toBe('unknown-provider')
  })
})

describe('Cursor usage error copy', () => {
  it('points stale Cursor tokens at IDE sign-in, not agent sessions', () => {
    const p: ProviderRateLimits = {
      provider: 'cursor',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Cursor sign-in expired — sign in to Cursor on the computer running Orca',
      status: 'unavailable',
      usageMetadata: { source: 'web', failureKind: 'stale-token' }
    }
    expect(getProviderUsageStatusLabel(p)).toBe('Sign in to Cursor')
    expect(getProviderUsageErrorMessage(p)).toMatch(/Sign in to Cursor/)
    expect(getProviderUsageErrorMessage(p)).not.toMatch(/Agent sessions/)
  })
})
