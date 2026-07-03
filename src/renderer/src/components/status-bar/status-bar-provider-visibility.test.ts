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
          kimi: null
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
          kimi: provider('unavailable', { provider: 'kimi' })
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
          kimi: provider('unavailable', { provider: 'kimi' })
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
          kimi: null
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
          kimi: provider('unavailable', { provider: 'kimi' })
        },
        usageSettings()
      )
    ).toBe(true)
  })
})
