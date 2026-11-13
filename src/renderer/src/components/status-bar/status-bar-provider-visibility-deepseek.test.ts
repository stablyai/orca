import { describe, expect, it } from 'vitest'
import {
  getVisibleUsageProvider,
  hasUsageProviderSettings,
  hasUsageProviderSettingsForProvider,
  type UsageProviderSettings
} from './status-bar-provider-visibility'

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
    deepseekAuthConfigured: false,
    ...overrides
  }
}

describe('DeepSeek status bar visibility', () => {
  it('treats deepseekAuthConfigured as a durable settings signal', () => {
    expect(hasUsageProviderSettings(usageSettings({ deepseekAuthConfigured: true }))).toBe(true)
    expect(
      hasUsageProviderSettingsForProvider('deepseek', usageSettings({ deepseekAuthConfigured: true }))
    ).toBe(true)
    expect(hasUsageProviderSettingsForProvider('deepseek', usageSettings())).toBe(false)
    expect(hasUsageProviderSettingsForProvider('deepseek', null)).toBe(false)
  })

  it('keeps DeepSeek visible while the snapshot is pending when an API key is configured', () => {
    const visible = getVisibleUsageProvider('deepseek', null, usageSettings({ deepseekAuthConfigured: true }))
    expect(visible).toMatchObject({
      provider: 'deepseek',
      status: 'fetching',
      session: null,
      weekly: null,
      monthly: null
    })
  })
})
