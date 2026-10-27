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

import { getProviderUsageErrorMessage, getProviderUsageStatusLabel } from './usage-error-copy'

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
