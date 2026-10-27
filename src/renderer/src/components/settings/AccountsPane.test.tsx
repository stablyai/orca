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
import { AccountsPane } from './AccountsPane'
import { resolveSettingsHostScope } from './settings-host-scope'
import { renderClaudeAccountsSection } from './accounts-pane-claude-section'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

function renderPane(
  settings: GlobalSettings,
  props: Partial<React.ComponentProps<typeof AccountsPane>> = {}
): string {
  return renderToStaticMarkup(
    React.createElement(AccountsPane, {
      settings,
      updateSettings: vi.fn(),
      hostScope: resolveSettingsHostScope({
        choice: null,
        defaultEnvironmentId: settings.activeRuntimeEnvironmentId,
        savedEnvironmentIds: [],
        catalogHydrated: false
      }),
      ...props
    })
  )
}

describe('AccountsPane', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    useAppStore.setState({ settingsSearchQuery: '', runtimeEnvironments: [] })
  })

  it('hides the WSL account location controls on platforms without WSL support', () => {
    const markup = renderPane({
      ...getDefaultSettings('/tmp'),
      localAccountRuntime: 'wsl'
    })

    expect(markup).not.toContain('Account location')
    expect(markup).not.toContain('aria-label="Account location"')
    expect(markup).not.toContain('WSL is not available on this machine.')
  })

  it('keeps the WSL account location controls on Windows-class hosts', () => {
    const markup = renderPane(
      {
        ...getDefaultSettings('/tmp'),
        localAccountRuntime: 'wsl'
      },
      { wslSupportedPlatform: true, wslCapabilitiesLoading: true }
    )

    expect(markup).toContain('Account location')
    expect(markup).toContain('aria-label="Account location"')
    expect(markup).toContain('role="radio" aria-checked="true" aria-disabled="true"')
  })

  it('selects the WSL account location under auto when the global project runtime is WSL', () => {
    // Shadow the read-only userAgent prototype getter, then remove the own property to restore it.
    const originalOwnUserAgent = Object.getOwnPropertyDescriptor(globalThis.navigator, 'userAgent')
    Object.defineProperty(globalThis.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      configurable: true
    })
    try {
      const markup = renderPane(
        {
          ...getDefaultSettings('/tmp'),
          localAccountRuntime: 'auto',
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        },
        { wslSupportedPlatform: true, wslCapabilitiesLoading: true }
      )

      expect(markup).toContain('aria-label="Account location"')
      expect(markup).toContain('role="radio" aria-checked="true" aria-disabled="true"')
    } finally {
      if (originalOwnUserAgent) {
        Object.defineProperty(globalThis.navigator, 'userAgent', originalOwnUserAgent)
      } else {
        delete (globalThis.navigator as { userAgent?: string }).userAgent
      }
    }
  })

  it('keeps the runtime label inside the localized account copy', () => {
    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).toContain('Showing accounts for this device. New accounts are added there.')
    expect(markup).toContain('authenticate with Google for this device. This uses credentials')
    expect(markup).not.toContain('ShowingThis device')
    expect(markup).not.toContain('forThis device')
  })

  it('localizes the runtime label before interpolating account copy', async () => {
    await i18n.changeLanguage('es')

    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).toMatch(
      /Mostrando cuentas para [Ee]ste dispositivo\. Las nuevas cuentas se agregan allí\./
    )
    expect(markup).not.toContain('This device')
  })

  it('scopes account copy to the active remote server and offers sign-in on that server', () => {
    // SSR reads Zustand’s initial state; this covers unnamed pre-hydration scope, while provider-account-scope.test covers named servers.
    const markup = renderPane(
      {
        ...getDefaultSettings('/tmp'),
        activeRuntimeEnvironmentId: 'env-1'
      },
      { wslSupportedPlatform: true }
    )

    expect(
      markup.split(
        'Showing accounts managed by the remote server. New accounts sign in there; you finish in this device’s browser.'
      ).length - 1
    ).toBe(2)
    // Both sections must reassure desktop users and link runtime selection so remote scope cannot look like lost accounts.
    expect(markup.split('Accounts managed on this desktop are unchanged').length - 1).toBe(2)
    expect(markup.split('Open Remote Servers').length - 1).toBe(2)
    // Unloaded server names must not interpolate prose fallbacks into scope labels.
    expect(markup).toContain('Account scope: Remote server<')
    expect(markup).not.toContain('Remote server: the remote server')
    expect(markup).not.toContain('aria-label="Account location"')
    const addButtons = [...markup.matchAll(/Add Account/g)].map(({ index }) =>
      markup.slice(markup.lastIndexOf('<button', index), index)
    )
    expect(addButtons).toHaveLength(2)
    for (const button of addButtons) {
      expect(button).not.toContain('disabled=""')
    }
    expect(markup).not.toContain('More sign-in options')
  })

  it('omits the scope control on the web client, which cannot select Local desktop', () => {
    const webGlobal = globalThis as { window?: { __ORCA_WEB_CLIENT__?: boolean } }
    const hadWindow = 'window' in webGlobal
    webGlobal.window = { ...webGlobal.window, __ORCA_WEB_CLIENT__: true }
    try {
      const markup = renderPane({
        ...getDefaultSettings('/tmp'),
        activeRuntimeEnvironmentId: 'env-1'
      })

      // Web clients cannot return to desktop-owned accounts, so that promise would be misleading.
      expect(markup).not.toContain('Accounts managed on this desktop are unchanged')
      expect(markup).not.toContain('Open Remote Servers')
      expect(markup).toContain('Showing accounts managed by')
    } finally {
      if (!hadWindow) {
        delete webGlobal.window
      }
    }
  })

  it('keeps local copy and enabled sign-in actions when no remote server is active', () => {
    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).toContain('Showing accounts for this device. New accounts are added there.')
    expect(markup).not.toContain('Open Remote Servers')
    const addAccountIndex = markup.indexOf('Add Account')
    expect(addAccountIndex).toBeGreaterThan(0)
    expect(
      markup.slice(markup.lastIndexOf('<button', addAccountIndex), addAccountIndex)
    ).not.toContain('disabled=""')
  })

  it('tells users to paste the OpenCode console session cookie, not auth alone', () => {
    const markup = renderPane(getDefaultSettings('/tmp'))

    expect(markup).toContain('__Host-console_session')
    expect(markup).toContain('auth=…; __Host-console_session=…')
    expect(markup).toContain('auth cookie still covers workspace discovery')
    expect(markup).not.toContain('Fe26.2**… token or auth=Fe26.2**… header')
  })
})

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
    updateSettings: vi.fn(),
    accountOwner: { kind: 'local' },
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
