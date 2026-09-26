// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { i18n } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import { renderClaudeAccountsSection } from './accounts-pane-claude-section'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

function buildModel(
  updateSettings: (updates: Partial<ReturnType<typeof getDefaultSettings>>) => void
): AccountsPaneSectionModel {
  const settings = getDefaultSettings('/tmp')
  return {
    settings,
    updateSettings,
    searchQuery: '',
    recordFeatureInteraction: vi.fn(),
    wslSupportedPlatform: false,
    wslAvailable: false,
    wslDistros: [],
    wslCapabilitiesLoading: false,
    localAccountRuntime: { runtime: 'host', label: 'This device' },
    localAccountRuntimeSentenceLabel: 'this device',
    isRemoteAccountScope: false,
    remoteServerName: null,
    remoteAccountScopeNotice: null,
    accountRuntime: { runtime: 'host', label: 'This device' },
    accountRuntimeSentenceLabel: 'this device',
    accountRuntimeUnavailable: false,
    accountVisibilityOptions: { remoteOwner: false, ownerPlatform: null },
    claudeAccounts: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    claudeAction: 'idle',
    visibleClaudeAccounts: [],
    systemClaudeActive: true,
    setRemoveClaudeTarget: vi.fn(),
    runClaudeAccountAction: vi.fn(),
    codexAccounts: {
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
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
    runCodexAccountAction: vi.fn(),
    recordOpenCodeSettingEdit: vi.fn(),
    miniMaxRateLimits: null,
    miniMaxApiKeyDraft: '',
    setMiniMaxApiKeyDraft: vi.fn(),
    miniMaxApiKeyConfigured: false,
    saveMiniMaxApiKey: vi.fn(),
    clearMiniMaxApiKey: vi.fn(),
    miniMaxCookieDraft: '',
    setMiniMaxCookieDraft: vi.fn(),
    miniMaxConfigured: false,
    miniMaxCredentialBusy: false,
    saveMiniMaxCookie: vi.fn(),
    clearMiniMaxCookie: vi.fn()
  }
}

async function renderSection(
  updateSettings: (updates: Partial<ReturnType<typeof getDefaultSettings>>) => void
): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(renderClaudeAccountsSection(buildModel(updateSettings)))
  })
  return { root, container }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('renderClaudeAccountsSection', () => {
  it('toggles the ask-per-project setting through updateSettings', async () => {
    await i18n.changeLanguage('en')
    useAppStore.setState({ settingsSearchQuery: '', runtimeEnvironments: [] })
    const updateSettings = vi.fn()
    const { root, container } = await renderSection(updateSettings)

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
