import { describe, expect, it } from 'vitest'
import type {
  ProviderRateLimits,
  ProviderRateLimitStatus
} from '../../../../shared/rate-limit-types'
import {
  getVisibleUsageProvider,
  hasUsageProviderSettings,
  hasUsageProviderSettingsForProvider,
  isUsageEmptyState,
  isProviderConfigured,
  type UsageProviderSettings
} from './status-bar-provider-visibility'

function provider(
  status: ProviderRateLimitStatus,
  overrides: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider: 'gemini',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status,
    ...overrides
  }
}

describe('isProviderConfigured', () => {
  it('hides a provider whose state has not loaded yet', () => {
    expect(isProviderConfigured(null)).toBe(false)
  })

  it('hides an unconfigured (unavailable) provider', () => {
    // The bug: Gemini OAuth off / OpenCode Go cookie unset returns a non-null
    // `unavailable` object, which previously slipped past the `!== null` gate
    // and rendered a "--" bar for a provider the user never configured.
    expect(isProviderConfigured(provider('unavailable'))).toBe(false)
  })

  it('hides a first-load fetching provider until it has proven usage data', () => {
    // The initial fetch marks every provider as `fetching`; without prior data
    // that state is not proof the user configured Gemini or OpenCode Go.
    expect(isProviderConfigured(provider('fetching'))).toBe(false)
  })

  it('shows configured providers, including ones failing transiently', () => {
    expect(isProviderConfigured(provider('ok'))).toBe(true)
    expect(isProviderConfigured(provider('error'))).toBe(true)
    expect(
      isProviderConfigured(
        provider('fetching', {
          session: {
            usedPercent: 25,
            windowMinutes: 300,
            resetsAt: null,
            resetDescription: null
          }
        })
      )
    ).toBe(true)
    expect(isProviderConfigured(provider('idle'))).toBe(true)
  })
})

function usageSettings(overrides: Partial<UsageProviderSettings> = {}): UsageProviderSettings {
  return {
    codexManagedAccounts: [],
    claudeManagedAccounts: [],
    opencodeSessionCookie: '',
    geminiCliOAuthEnabled: false,
    antigravityUsageConfigured: false,
    minimaxCookieConfigured: false,
    grokAuthConfigured: false,
    ...overrides
  }
}

describe('hasUsageProviderSettings', () => {
  it('treats persisted managed accounts as configured usage providers', () => {
    expect(
      hasUsageProviderSettings(
        usageSettings({
          codexManagedAccounts: [
            {
              id: 'codex-account-1',
              email: 'dev@example.com',
              managedHomePath: '/tmp/codex-account-1',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            }
          ]
        })
      )
    ).toBe(true)

    expect(
      hasUsageProviderSettings(
        usageSettings({
          claudeManagedAccounts: [
            {
              id: 'claude-account-1',
              email: 'dev@example.com',
              managedAuthPath: '/tmp/claude-account-1',
              authMethod: 'subscription-oauth',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            }
          ]
        })
      )
    ).toBe(true)
  })

  it('treats explicit non-managed provider settings as configured usage providers', () => {
    expect(hasUsageProviderSettings(usageSettings({ geminiCliOAuthEnabled: true }))).toBe(true)
    expect(
      hasUsageProviderSettings(usageSettings({ opencodeSessionCookie: ' session=abc ' }))
    ).toBe(true)
    // Why: antigravity durability requires the Gemini OAuth opt-in; the
    // checked item alone must not suppress the usage setup CTA.
    expect(hasUsageProviderSettings(usageSettings({ antigravityUsageConfigured: true }))).toBe(
      false
    )
    expect(hasUsageProviderSettings(usageSettings({ minimaxCookieConfigured: true }))).toBe(true)
    expect(hasUsageProviderSettings(usageSettings({ grokAuthConfigured: true }))).toBe(true)
  })

  it('does not treat empty or unloaded settings as configured', () => {
    expect(hasUsageProviderSettings(usageSettings())).toBe(false)
    expect(hasUsageProviderSettings(null)).toBe(false)
  })
})

describe('hasUsageProviderSettingsForProvider', () => {
  it('checks durable configuration for a single provider', () => {
    expect(
      hasUsageProviderSettingsForProvider(
        'codex',
        usageSettings({
          codexManagedAccounts: [
            {
              id: 'codex-account-1',
              email: 'dev@example.com',
              managedHomePath: '/tmp/codex-account-1',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            }
          ]
        })
      )
    ).toBe(true)
    expect(hasUsageProviderSettingsForProvider('claude', usageSettings())).toBe(false)
    expect(hasUsageProviderSettingsForProvider('kimi', usageSettings())).toBe(false)
    expect(hasUsageProviderSettingsForProvider('grok', usageSettings())).toBe(false)
  })

  it('requires both a checked Antigravity item and Gemini OAuth as the durable Antigravity signal', () => {
    expect(
      hasUsageProviderSettingsForProvider(
        'antigravity',
        usageSettings({ antigravityUsageConfigured: true, geminiCliOAuthEnabled: true })
      )
    ).toBe(true)
    // Why: the snapshot mirrors the Gemini fetch — without the OAuth opt-in it
    // is permanently unavailable, so the checked item alone is not durable.
    expect(
      hasUsageProviderSettingsForProvider(
        'antigravity',
        usageSettings({ antigravityUsageConfigured: true })
      )
    ).toBe(false)
    expect(
      hasUsageProviderSettingsForProvider(
        'antigravity',
        usageSettings({ geminiCliOAuthEnabled: true })
      )
    ).toBe(false)
    expect(hasUsageProviderSettingsForProvider('antigravity', usageSettings())).toBe(false)
    expect(hasUsageProviderSettingsForProvider('antigravity', null)).toBe(false)
  })

  it('treats minimaxCookieConfigured as the durable signal for MiniMax', () => {
    expect(
      hasUsageProviderSettingsForProvider(
        'minimax',
        usageSettings({ minimaxCookieConfigured: true })
      )
    ).toBe(true)
    expect(hasUsageProviderSettingsForProvider('minimax', usageSettings())).toBe(false)
    expect(hasUsageProviderSettingsForProvider('minimax', null)).toBe(false)
  })

  it('treats grokAuthConfigured as the durable signal for Grok', () => {
    expect(
      hasUsageProviderSettingsForProvider('grok', usageSettings({ grokAuthConfigured: true }))
    ).toBe(true)
    expect(hasUsageProviderSettingsForProvider('grok', usageSettings())).toBe(false)
    expect(hasUsageProviderSettingsForProvider('grok', null)).toBe(false)
  })
})

describe('getVisibleUsageProvider', () => {
  it('keeps configured managed-account providers visible while snapshots are pending', () => {
    const visible = getVisibleUsageProvider(
      'codex',
      null,
      usageSettings({
        codexManagedAccounts: [
          {
            id: 'codex-account-1',
            email: 'dev@example.com',
            managedHomePath: '/tmp/codex-account-1',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ]
      })
    )

    expect(visible).toMatchObject({
      provider: 'codex',
      status: 'fetching',
      session: null,
      weekly: null
    })
  })

  it('keeps configured providers visible when a fetch returns unavailable', () => {
    const unavailable = provider('unavailable', {
      provider: 'claude',
      error: 'Claude OAuth access token unavailable'
    })

    expect(
      getVisibleUsageProvider(
        'claude',
        unavailable,
        usageSettings({
          claudeManagedAccounts: [
            {
              id: 'claude-account-1',
              email: 'dev@example.com',
              managedAuthPath: '/tmp/claude-account-1',
              authMethod: 'subscription-oauth',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            }
          ]
        })
      )
    ).toBe(unavailable)
  })

  it('hides providers with no live data or durable configuration', () => {
    expect(getVisibleUsageProvider('codex', null, usageSettings())).toBe(null)
    expect(getVisibleUsageProvider('gemini', provider('fetching'), usageSettings())).toBe(null)
  })

  it('keeps MiniMax visible while the snapshot is pending when a cookie is configured', () => {
    const visible = getVisibleUsageProvider(
      'minimax',
      null,
      usageSettings({ minimaxCookieConfigured: true })
    )
    expect(visible).toMatchObject({
      provider: 'minimax',
      status: 'fetching',
      session: null,
      weekly: null
    })
  })

  it('keeps Grok visible while the snapshot is pending when CLI auth is configured', () => {
    const visible = getVisibleUsageProvider(
      'grok',
      null,
      usageSettings({ grokAuthConfigured: true })
    )
    expect(visible).toMatchObject({
      provider: 'grok',
      status: 'fetching',
      session: null,
      weekly: null
    })
  })

  it('keeps MiniMax visible when the fetch returns unavailable for a configured cookie', () => {
    const unavailable = provider('unavailable', {
      provider: 'minimax',
      error: 'MiniMax session expired. Replace the MiniMax cookie in Settings.'
    })
    expect(
      getVisibleUsageProvider(
        'minimax',
        unavailable,
        usageSettings({ minimaxCookieConfigured: true })
      )
    ).toBe(unavailable)
  })

  it('hides MiniMax when no cookie is configured and the snapshot is empty', () => {
    expect(getVisibleUsageProvider('minimax', null, usageSettings())).toBe(null)
    expect(
      getVisibleUsageProvider(
        'minimax',
        provider('unavailable', { provider: 'minimax' }),
        usageSettings()
      )
    ).toBe(null)
  })

  it('keeps Antigravity visible while the snapshot is pending when checked and Gemini OAuth is on', () => {
    const visible = getVisibleUsageProvider(
      'antigravity',
      null,
      usageSettings({ antigravityUsageConfigured: true, geminiCliOAuthEnabled: true })
    )
    expect(visible).toMatchObject({
      provider: 'antigravity',
      status: 'fetching',
      session: null,
      weekly: null
    })
  })

  it('hides Antigravity while Gemini OAuth is off even when its status item is checked', () => {
    // Why: without the OAuth opt-in the mirrored snapshot is permanently
    // 'unavailable'; the default-on item must not pin a dead bar.
    expect(
      getVisibleUsageProvider(
        'antigravity',
        null,
        usageSettings({ antigravityUsageConfigured: true })
      )
    ).toBe(null)
    expect(
      getVisibleUsageProvider(
        'antigravity',
        provider('unavailable', {
          provider: 'antigravity',
          error: 'Gemini CLI OAuth is disabled in settings'
        }),
        usageSettings({ antigravityUsageConfigured: true })
      )
    ).toBe(null)
  })
})

describe('isUsageEmptyState', () => {
  it('waits for provider snapshots before showing the setup CTA', () => {
    expect(
      isUsageEmptyState(
        {
          claude: null,
          codex: null,
          gemini: null,
          opencodeGo: null,
          kimi: null,
          antigravity: null,
          minimax: null,
          grok: null
        },
        usageSettings()
      )
    ).toBe(false)
  })

  it('does not show the setup CTA while system-default usage snapshots are fetching', () => {
    expect(
      isUsageEmptyState(
        {
          claude: provider('fetching', { provider: 'claude' }),
          codex: provider('fetching', { provider: 'codex' }),
          gemini: provider('unavailable'),
          opencodeGo: provider('unavailable', { provider: 'opencode-go' }),
          kimi: provider('unavailable', { provider: 'kimi' }),
          antigravity: provider('unavailable', { provider: 'antigravity' }),
          minimax: provider('unavailable', { provider: 'minimax' }),
          grok: provider('unavailable', { provider: 'grok' })
        },
        usageSettings()
      )
    ).toBe(false)
  })

  it('does not show the setup CTA when persisted accounts exist but snapshots have no usage data', () => {
    expect(
      isUsageEmptyState(
        {
          claude: provider('unavailable', { provider: 'claude' }),
          codex: provider('unavailable', { provider: 'codex' }),
          gemini: provider('unavailable'),
          opencodeGo: provider('unavailable', { provider: 'opencode-go' }),
          kimi: provider('unavailable', { provider: 'kimi' }),
          antigravity: provider('unavailable', { provider: 'antigravity' }),
          minimax: provider('unavailable', { provider: 'minimax' }),
          grok: provider('unavailable', { provider: 'grok' })
        },
        usageSettings({
          codexManagedAccounts: [
            {
              id: 'codex-account-1',
              email: 'dev@example.com',
              managedHomePath: '/tmp/codex-account-1',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            }
          ]
        })
      )
    ).toBe(false)
  })

  it('waits for settings before showing the setup CTA', () => {
    expect(
      isUsageEmptyState(
        {
          claude: null,
          codex: null,
          gemini: null,
          opencodeGo: null,
          kimi: null,
          antigravity: null,
          minimax: null,
          grok: null
        },
        null
      )
    ).toBe(false)
  })

  it('shows the setup CTA for a loaded profile with no configured usage provider', () => {
    expect(
      isUsageEmptyState(
        {
          claude: provider('unavailable', { provider: 'claude' }),
          codex: provider('unavailable', { provider: 'codex' }),
          gemini: provider('unavailable'),
          opencodeGo: provider('unavailable', { provider: 'opencode-go' }),
          kimi: provider('unavailable', { provider: 'kimi' }),
          antigravity: null,
          minimax: provider('unavailable', { provider: 'minimax' }),
          grok: provider('unavailable', { provider: 'grok' })
        },
        usageSettings()
      )
    ).toBe(true)
  })

  it('does not show the setup CTA while checked Antigravity usage is awaiting a snapshot', () => {
    expect(
      isUsageEmptyState(
        {
          claude: provider('unavailable', { provider: 'claude' }),
          codex: provider('unavailable', { provider: 'codex' }),
          gemini: provider('unavailable'),
          opencodeGo: provider('unavailable', { provider: 'opencode-go' }),
          kimi: provider('unavailable', { provider: 'kimi' }),
          antigravity: null,
          grok: provider('unavailable', { provider: 'grok' }),
          minimax: provider('unavailable', { provider: 'minimax' })
        },
        usageSettings({ antigravityUsageConfigured: true, geminiCliOAuthEnabled: true })
      )
    ).toBe(false)
  })

  it('still shows the setup CTA when Antigravity is checked but Gemini OAuth is off', () => {
    // Why: the default-on Antigravity item is not configured usage on its own;
    // it must not hide the teaching CTA from users who set nothing up.
    expect(
      isUsageEmptyState(
        {
          claude: provider('unavailable', { provider: 'claude' }),
          codex: provider('unavailable', { provider: 'codex' }),
          gemini: provider('unavailable'),
          opencodeGo: provider('unavailable', { provider: 'opencode-go' }),
          kimi: provider('unavailable', { provider: 'kimi' }),
          antigravity: null,
          grok: provider('unavailable', { provider: 'grok' }),
          minimax: provider('unavailable', { provider: 'minimax' })
        },
        usageSettings({ antigravityUsageConfigured: true })
      )
    ).toBe(true)
  })
})
