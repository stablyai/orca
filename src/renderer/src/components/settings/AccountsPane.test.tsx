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
      // Why: mirrors the page before the user picks a host — the default host setting.
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
    // Why: navigator.userAgent is a read-only prototype getter, so shadow it with
    // a configurable own property and remove that shadow afterward to restore it.
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
      // The resolved WSL radio is the checked option (unavailable while capabilities load).
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
    // Note: static SSR markup reads the store's initial state (zustand v5), so
    // this exercises the pre-hydration path where no server name is known yet.
    // The named-server label is covered in provider-account-scope.test.ts.
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
    // Both the Claude and Codex sections must say local accounts are intact and
    // link the default-runtime control, so the scoped list never reads as loss.
    expect(markup.split('Accounts managed on this desktop are unchanged').length - 1).toBe(2)
    expect(markup.split('Open Remote Servers').length - 1).toBe(2)
    // Before the saved-server list loads there is no name to interpolate, so the
    // scope label must stay bare instead of stuttering the prose fallback.
    expect(markup).toContain('Account scope: Remote server<')
    expect(markup).not.toContain('Remote server: the remote server')
    // The WSL account-location toggle is a local concern; a remote owner hides it.
    expect(markup).not.toContain('aria-label="Account location"')
    // #20009: Add Account runs the server's own login, so neither section's button is inert.
    const addButtons = [...markup.matchAll(/Add Account/g)].map(({ index }) =>
      markup.slice(markup.lastIndexOf('<button', index), index)
    )
    expect(addButtons).toHaveLength(2)
    for (const button of addButtons) {
      expect(button).not.toContain('disabled=""')
    }
    // "Copy sign-in link instead" hands over a link that calls back to this device.
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

      // The web client has no desktop-managed accounts to switch back to, so
      // this copy would promise a move it cannot make.
      expect(markup).not.toContain('Accounts managed on this desktop are unchanged')
      expect(markup).not.toContain('Open Remote Servers')
      // The server-scope copy itself still applies.
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
    // Unused by the Claude section; present only so the model is the real type.
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
