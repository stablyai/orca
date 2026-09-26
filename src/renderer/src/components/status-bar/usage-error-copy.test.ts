import { describe, expect, it, vi } from 'vitest'

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
    expect(getProviderDisplayName('deepseek')).toBe('DeepSeek')
  })

  it('falls back to the raw provider id when no mapping exists', () => {
    // Why: provider id is a closed union, but TypeScript may not enforce
    // exhaustiveness on dynamic callers. Fallback keeps logging safe.
    expect(getProviderDisplayName('unknown-provider' as never)).toBe('unknown-provider')
  })
})

describe('unsubscribed OpenCode Go accounts', () => {
  const noSubscription = {
    provider: 'opencode-go',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: 0,
    error:
      'This OpenCode account has no OpenCode Go subscription. Subscribe at opencode.ai to see Go usage.',
    status: 'error',
    usageMetadata: { failureKind: 'no-subscription' }
  } as const

  it('labels the entitlement verdict instead of a refresh failure', () => {
    expect(getProviderUsageStatusLabel(noSubscription)).toBe('No subscription')
  })

  it('keeps the specific message rather than the generic auth copy', () => {
    expect(getProviderUsageErrorMessage(noSubscription)).toBe(noSubscription.error)
  })
})
