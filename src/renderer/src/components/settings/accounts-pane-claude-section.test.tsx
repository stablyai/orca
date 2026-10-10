import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import { i18n } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import { renderClaudeAccountsSection } from './accounts-pane-claude-section'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

function account(
  id: string,
  email: string,
  overrides: Partial<ClaudeManagedAccountSummary> = {}
): ClaudeManagedAccountSummary {
  return {
    id,
    email,
    managedAuthRuntime: 'host',
    wslDistro: null,
    authMethod: 'subscription-oauth',
    organizationUuid: null,
    organizationName: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...overrides
  }
}

function render(
  state: Partial<ClaudeRateLimitAccountsState> = {},
  settings: Partial<GlobalSettings> = {}
): string {
  const claudeAccounts: ClaudeRateLimitAccountsState = {
    accounts: [],
    activeAccountId: null,
    ...state
  }
  const accountRuntime = { runtime: 'host' as const, wslDistro: null, label: 'This device' }
  const model: AccountsPaneSectionModel = {
    // Unused by the Claude section; present only so the model is the real type.
    updateSettings: vi.fn(),
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
    claudeAccounts,
    claudeAction: 'idle',
    isRemoteAccountScope: false,
    remoteAccountScopeNotice: null,
    runClaudeAccountAction: vi.fn(async () => {}),
    setRemoveClaudeTarget: vi.fn(),
    settings: { ...getDefaultSettings('/tmp'), ...settings },
    systemClaudeActive: claudeAccounts.activeAccountId === null,
    visibleClaudeAccounts: claudeAccounts.accounts,
    wslCapabilitiesLoading: false
  }
  return renderToStaticMarkup(React.createElement(() => renderClaudeAccountsSection(model)))
}

function selectButtons(markup: string): string[] {
  return [
    ...markup.matchAll(/<button type="button"[^>]*class="flex min-w-0 flex-1[^"]*"[^>]*>/g)
  ].map(([button]) => button)
}

describe('Claude accounts section', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    useAppStore.setState({ settingsSearchQuery: '', runtimeEnvironments: [] })
  })

  it('asks a folder with no login to sign in again, and keeps it unselectable but removable', () => {
    const markup = render({
      accounts: [
        account('legacy', 'old@example.test', { needsSignIn: true }),
        account('ready', 'ok@example.test')
      ]
    })
    expect(markup).toContain('Sign in again to use this account')
    expect(selectButtons(markup).map((button) => button.includes('disabled=""'))).toEqual([
      true,
      false
    ])
    expect(markup.match(/>Remove<\/button>/g)).toHaveLength(2)
  })

  it("names System default's login and warns only when an older Orca may have copied it there", () => {
    const saved = {
      accounts: [account('a', 'A@example.test')],
      systemDefaultEmail: 'a@example.test'
    }
    const copied = render({ ...saved, systemDefaultMayBeCopied: true })
    expect(copied).toContain('System default: a@example.test')
    expect(copied).toContain('An earlier Orca version may have copied that login there.')
    expect(copied).toContain('>Dismiss</button>')
    // Saving your own login as an account too is normal: no copy evidence, no warning.
    expect(render(saved)).not.toContain('An earlier Orca version')
    expect(
      render(
        { ...saved, systemDefaultMayBeCopied: true },
        { claudeCopiedSystemDefaultNoticeDismissed: true }
      )
    ).not.toContain('An earlier Orca version')
    const own = render({
      ...saved,
      systemDefaultEmail: 'me@example.test',
      systemDefaultMayBeCopied: true
    })
    expect(own).toContain('System default: me@example.test')
    expect(own).not.toContain('An earlier Orca version')
  })
})
