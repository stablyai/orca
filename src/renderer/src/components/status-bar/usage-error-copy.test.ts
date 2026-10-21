import { describe, expect, it, vi } from 'vitest'

const i18nState = vi.hoisted(() => ({ language: 'en' }))

vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback: string, values?: Record<string, string>) => {
    let result =
      i18nState.language === 'ja' && key.endsWith('remoteOwnerNotConfigured')
        ? '{{server}} では未構成'
        : fallback
    for (const [name, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${name}}}`, value)
    }
    return result
  }
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

describe('structured failure kinds over message wording', () => {
  // Captured from codex-cli 0.162.0 `app-server` behind an unreachable proxy.
  const codexNetworkFailure = {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: 0,
    error:
      'failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)',
    status: 'error',
    usageMetadata: { failureKind: 'network' }
  } as const

  it('labels a network failure that names rate limits as a network issue, not Limited', () => {
    expect(getProviderUsageStatusLabel(codexNetworkFailure)).toBe('Network issue')
    expect(getProviderUsageErrorMessage(codexNetworkFailure)).toBe(codexNetworkFailure.error)
  })

  it('labels a network failure as a network issue for every provider', () => {
    for (const provider of [
      'gemini',
      'grok',
      'kimi',
      'opencode-go',
      'minimax',
      'cursor'
    ] as const) {
      expect(
        getProviderUsageStatusLabel({ ...codexNetworkFailure, provider, error: 'fetch failed' })
      ).toBe('Network issue')
    }
    expect(
      getProviderUsageStatusLabel({ ...codexNetworkFailure, provider: 'claude', error: 'x' })
    ).toBe('Network issue')
  })

  it('labels real rate limiting as Limited, with or without a kind', () => {
    expect(
      getProviderUsageStatusLabel({
        ...codexNetworkFailure,
        error: 'failed to fetch codex rate limits: unexpected status 429 Too Many Requests',
        usageMetadata: undefined
      })
    ).toBe('Limited')
    expect(
      getProviderUsageStatusLabel({
        ...codexNetworkFailure,
        provider: 'antigravity',
        error:
          'Antigravity usage is not available right now. The Antigravity API is rate-limiting this account.',
        usageMetadata: { failureKind: 'rate-limited' }
      })
    ).toBe('Limited')
  })

  it('keeps the unclassified labels', () => {
    const unclassified = { ...codexNetworkFailure, usageMetadata: undefined }
    expect(
      getProviderUsageStatusLabel({
        ...unclassified,
        error: 'chatgpt authentication required to read rate limits'
      })
    ).toBe('Refresh failed')
    expect(getProviderUsageStatusLabel({ ...unclassified, error: 'RPC failed' })).toBe(
      'Refresh failed'
    )
    expect(
      getProviderUsageStatusLabel({
        ...unclassified,
        error: 'boom',
        usageMetadata: { failureKind: 'unknown' }
      })
    ).toBe('Refresh failed')
    expect(
      getProviderUsageStatusLabel({
        ...unclassified,
        provider: 'claude',
        error: 'Claude usage is rate limited right now.',
        usageMetadata: { failureKind: 'rate-limited' }
      })
    ).toBe('Limited')
  })
})

describe('owner placeholder tooltip', () => {
  it('follows the current language, not the one the placeholder was built in', () => {
    const placeholder = {
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: 0,
      error: 'Not configured on devbox',
      status: 'error',
      usageMetadata: {
        ownerNotSetUp: { kind: 'not-configured', ownerLabel: 'devbox', signInSavedHereOnly: false }
      }
    } as const
    i18nState.language = 'ja'
    try {
      expect(getProviderUsageErrorMessage(placeholder)).toBe('devbox では未構成')
    } finally {
      i18nState.language = 'en'
    }
    expect(getProviderUsageErrorMessage(placeholder)).toBe('Not configured on devbox')
  })
})
