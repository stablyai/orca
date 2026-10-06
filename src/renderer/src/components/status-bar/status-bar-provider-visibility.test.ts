import { describe, expect, it } from 'vitest'
import type {
  ProviderRateLimits,
  ProviderRateLimitStatus
} from '../../../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
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
    expect(isProviderConfigured(undefined)).toBe(false)
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
    minimaxApiKeyConfigured: false,
    opencodeGoApiKeyConfigured: false,
    grokAuthConfigured: false,
    cursorAuthConfigured: false,
    zcodePlanApiKeyConfigured: false,
    ...overrides
  }
}

describe('hasUsageProviderSettings', () => {
  it('keeps a linked GLM plan visible without CLI detection or a first quota result', () => {
    const settings = usageSettings({ zcodePlanApiKeyConfigured: true })
    expect(hasUsageProviderSettings(settings)).toBe(true)
    expect(getVisibleUsageProvider('zcode', null, settings)?.status).toBe('fetching')
    expect(getVisibleUsageProvider('zcode', null, usageSettings())).toBeNull()
  })

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
    // Why: the checked item + PATH detection is durable on its own — the
    // snapshot comes from the `agy` CLI probe and needs no Gemini OAuth.
    expect(hasUsageProviderSettings(usageSettings({ antigravityUsageConfigured: true }))).toBe(true)
    // Why: an OPENCODE_API_KEY or a key OpenCode saved on /connect is invisible
    // to the renderer, so main's presence flag is the only durable signal.
    expect(hasUsageProviderSettings(usageSettings({ opencodeGoApiKeyConfigured: true }))).toBe(true)
    expect(
      hasUsageProviderSettingsForProvider(
        'opencode-go',
        usageSettings({ opencodeGoApiKeyConfigured: true })
      )
    ).toBe(true)
    expect(hasUsageProviderSettingsForProvider('opencode-go', usageSettings())).toBe(false)
    expect(hasUsageProviderSettings(usageSettings({ minimaxCookieConfigured: true }))).toBe(true)
    expect(hasUsageProviderSettings(usageSettings({ minimaxApiKeyConfigured: true }))).toBe(true)
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

  it('treats the checked Antigravity item as the durable Antigravity signal', () => {
    expect(
      hasUsageProviderSettingsForProvider(
        'antigravity',
        usageSettings({ antigravityUsageConfigured: true })
      )
    ).toBe(true)
    // Why no Gemini OAuth term: the snapshot comes from the `agy` CLI probe, so
    // the OAuth opt-in says nothing about Antigravity.
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

  it('treats minimaxApiKeyConfigured as a parallel durable signal for MiniMax', () => {
    // Why: CN endpoint users can configure MiniMax with an API key only. The
    // visibility check must accept either credential so the status bar stays
    // visible while the snapshot is still pending.
    expect(
      hasUsageProviderSettingsForProvider(
        'minimax',
        usageSettings({ minimaxApiKeyConfigured: true })
      )
    ).toBe(true)
    expect(
      hasUsageProviderSettingsForProvider(
        'minimax',
        usageSettings({ minimaxApiKeyConfigured: false, minimaxCookieConfigured: false })
      )
    ).toBe(false)
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
    expect(getVisibleUsageProvider('grok', undefined, usageSettings())).toBe(null)
    expect(getVisibleUsageProvider('gemini', provider('fetching'), usageSettings())).toBe(null)
  })

  it('creates a pending snapshot when an older main process omits a configured provider', () => {
    expect(
      getVisibleUsageProvider('grok', undefined, usageSettings({ grokAuthConfigured: true }))
    ).toMatchObject({ provider: 'grok', status: 'fetching' })
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

  it('keeps Antigravity visible from the checked item alone while the snapshot is pending', () => {
    const visible = getVisibleUsageProvider(
      'antigravity',
      null,
      usageSettings({ antigravityUsageConfigured: true })
    )
    expect(visible).toMatchObject({
      provider: 'antigravity',
      status: 'fetching',
      session: null,
      weekly: null
    })
  })

  it('hides Antigravity when its status item is unchecked', () => {
    // Why: without the checked item there is no durable signal, so an unavailable
    // snapshot (e.g. a signed-out agy) must not pin a bar the user never asked for.
    expect(getVisibleUsageProvider('antigravity', null, usageSettings())).toBe(null)
    expect(
      getVisibleUsageProvider(
        'antigravity',
        provider('unavailable', { provider: 'antigravity' }),
        usageSettings()
      )
    ).toBe(null)
  })
})

describe('isUsageEmptyState', () => {
  it('keeps the Cursor bar visible on a local session before the first snapshot', () => {
    // Why: the credential lives on disk, not in settings, so main's flag is the
    // only durable signal that the bar has an account behind it.
    const pending = getVisibleUsageProvider(
      'cursor',
      null,
      usageSettings({ cursorAuthConfigured: true })
    )
    expect(pending).toMatchObject({ provider: 'cursor', status: 'fetching' })
    expect(getVisibleUsageProvider('cursor', null, usageSettings())).toBeNull()
  })

  it('hides the Cursor bar when no local session exists, even on an unavailable snapshot', () => {
    // Why: 'unavailable' is how a signed-out host reports Cursor; without the
    // durable flag there is no account to show a bar for.
    const unavailable = provider('unavailable', { provider: 'cursor' })
    expect(getVisibleUsageProvider('cursor', unavailable, usageSettings())).toBeNull()
    // With a session on disk the row stays, so "no allowance" is explained
    // rather than silently vanishing.
    expect(
      getVisibleUsageProvider('cursor', unavailable, usageSettings({ cursorAuthConfigured: true }))
    ).toBe(unavailable)
  })

  it('keeps a failing Cursor refresh visible so the error is not silently hidden', () => {
    const failing = provider('error', { provider: 'cursor' })
    expect(getVisibleUsageProvider('cursor', failing, usageSettings())).toBe(failing)
  })

  it('waits for provider snapshots before showing the setup CTA', () => {
    expect(isUsageEmptyState(createEmptyRateLimitState(), usageSettings())).toBe(false)
  })

  it('treats provider keys omitted by an older main process as pending', () => {
    expect(
      isUsageEmptyState(
        {
          claude: provider('unavailable', { provider: 'claude' }),
          codex: provider('unavailable', { provider: 'codex' }),
          gemini: provider('unavailable'),
          opencodeGo: provider('unavailable', { provider: 'opencode-go' }),
          kimi: provider('unavailable', { provider: 'kimi' }),
          antigravity: undefined,
          minimax: undefined,
          grok: undefined,
          cursor: undefined
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
          grok: provider('unavailable', { provider: 'grok' }),
          cursor: provider('unavailable', { provider: 'cursor' }),
          zcode: provider('unavailable', { provider: 'zcode' })
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
          grok: provider('unavailable', { provider: 'grok' }),
          cursor: provider('unavailable', { provider: 'cursor' }),
          zcode: provider('unavailable', { provider: 'zcode' })
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
    expect(isUsageEmptyState(createEmptyRateLimitState(), null)).toBe(false)
  })

  it('shows the setup CTA for a loaded profile with no configured usage provider', () => {
    const settledProviders = {
      claude: provider('unavailable', { provider: 'claude' }),
      codex: provider('unavailable', { provider: 'codex' }),
      gemini: provider('unavailable'),
      opencodeGo: provider('unavailable', { provider: 'opencode-go' }),
      kimi: provider('unavailable', { provider: 'kimi' }),
      antigravity: null,
      minimax: provider('unavailable', { provider: 'minimax' }),
      grok: provider('unavailable', { provider: 'grok' }),
      cursor: provider('unavailable', { provider: 'cursor' }),
      zcode: provider('unavailable', { provider: 'zcode' })
    }
    expect(isUsageEmptyState(settledProviders, usageSettings())).toBe(true)
    expect(isUsageEmptyState({ ...settledProviders, zcode: undefined }, usageSettings())).toBe(true)
    expect(isUsageEmptyState({ ...settledProviders, zcode: null }, usageSettings())).toBe(false)
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
          minimax: provider('unavailable', { provider: 'minimax' }),
          cursor: provider('unavailable', { provider: 'cursor' }),
          zcode: provider('unavailable', { provider: 'zcode' })
        },
        usageSettings({ antigravityUsageConfigured: true })
      )
    ).toBe(false)
  })

  it('still shows the setup CTA when no agent is detected, even with the Antigravity item checked', () => {
    // Why: `antigravityUsageConfigured` is checked item + PATH detection, so a
    // profile with nothing installed never counts Antigravity as set up.
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
          minimax: provider('unavailable', { provider: 'minimax' }),
          cursor: provider('unavailable', { provider: 'cursor' }),
          zcode: provider('unavailable', { provider: 'zcode' })
        },
        usageSettings()
      )
    ).toBe(true)
  })
})
