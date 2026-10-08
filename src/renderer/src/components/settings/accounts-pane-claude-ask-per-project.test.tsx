// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { i18n } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import { renderClaudeAccountsSection } from './accounts-pane-claude-section'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

function buildModel(updateSettings: AccountsPaneSectionModel['updateSettings']) {
  const accountRuntime = { runtime: 'host' as const, wslDistro: null, label: 'This device' }
  const model: AccountsPaneSectionModel = {
    updateSettings,
    searchQuery: '',
    recordFeatureInteraction: vi.fn(),
    wslSupportedPlatform: false,
    wslAvailable: false,
    wslDistros: [],
    localAccountRuntime: accountRuntime,
    localAccountRuntimeSentenceLabel: 'this device',
    remoteServerName: null,
    codexAccounts: { accounts: [], activeAccountId: null },
    codexAction: 'idle',
    visibleCodexAccounts: [],
    systemCodexActive: true,
    systemCodexNeedsSignIn: false,
    systemCodexMissingSignIn: false,
    systemCodexIdentity: undefined,
    activeCodexAuthWarning: null,
    activeCodexAccountId: null,
    codexConfigSync: null,
    codexConfigSyncWarning: null,
    codexRateLimits: null,
    codexRateLimitTarget: { runtime: 'host', wslDistro: null },
    setRemoveCodexTarget: vi.fn(),
    runCodexAccountAction: vi.fn(async () => {}),
    recordOpenCodeSettingEdit: vi.fn(),
    miniMaxRateLimits: null,
    miniMaxApiKeyDraft: '',
    setMiniMaxApiKeyDraft: vi.fn(),
    miniMaxApiKeyConfigured: false,
    miniMaxApiKeyProtection: null,
    saveMiniMaxApiKey: vi.fn(async () => {}),
    clearMiniMaxApiKey: vi.fn(async () => {}),
    miniMaxCookieDraft: '',
    setMiniMaxCookieDraft: vi.fn(),
    miniMaxConfigured: false,
    miniMaxCookieProtection: null,
    miniMaxCredentialBusy: false,
    saveMiniMaxCookie: vi.fn(async () => {}),
    clearMiniMaxCookie: vi.fn(async () => {}),
    accountRuntime,
    accountRuntimeSentenceLabel: 'this device',
    accountRuntimeUnavailable: false,
    accountVisibilityOptions: { remoteOwner: false, ownerPlatform: 'darwin' },
    claudeAccounts: { accounts: [], activeAccountId: null },
    claudeAction: 'idle',
    isRemoteAccountScope: false,
    remoteAccountScopeNotice: null,
    runClaudeAccountAction: vi.fn(async () => {}),
    setRemoveClaudeTarget: vi.fn(),
    settings: getDefaultSettings('/tmp'),
    systemClaudeActive: true,
    visibleClaudeAccounts: [],
    wslCapabilitiesLoading: false
  }
  return model
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('Claude accounts section ask-per-project setting', () => {
  it('saves the toggle through updateSettings', async () => {
    await i18n.changeLanguage('en')
    useAppStore.setState({ settingsSearchQuery: '', runtimeEnvironments: [] })
    const updateSettings = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(renderClaudeAccountsSection(buildModel(updateSettings)))
    })

    const switchButton = container.querySelector<HTMLButtonElement>(
      '#accounts-claude-ask-per-project button[role="switch"]'
    )
    if (!switchButton) {
      throw new Error('Ask-per-project switch was not rendered')
    }
    await act(async () => {
      switchButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ askClaudeAccountPerProject: true })
    root.unmount()
  })
})
