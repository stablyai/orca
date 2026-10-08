// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type {
  ClaudeManagedAccount,
  ClaudeRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { getDefaultSettings } from '../../../../shared/constants'

const toastError = vi.fn()
const fetchSettings = vi.fn(async () => {})
const reauthenticate = vi.fn(async (_args: unknown) => snapshot())
const selectClaudeProviderAccount = vi.fn(async () => snapshot())
let storeSettings: GlobalSettings
let activeRuntimeEnvironmentId: string | null = null

function account(id: string): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused',
    createdAt: 1,
    updatedAt: id === 'old' ? 2 : 1,
    lastAuthenticatedAt: 1
  }
}

function snapshot(): ClaudeRateLimitAccountsState {
  return {
    accounts: [{ ...account('old'), needsSignIn: true }, { ...account('new') }],
    activeAccountId: 'old',
    activeAccountIdsByRuntime: { host: 'old', wsl: {} }
  }
}

vi.mock('sonner', () => ({ toast: { error: toastError, info: vi.fn(), success: vi.fn() } }))
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot: vi.fn(async () => ({
    claude: snapshot(),
    codex: { accounts: [], activeAccountId: null },
    failedProviders: []
  })),
  selectClaudeProviderAccount
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ getActiveRuntimeTarget: () => null }))
vi.mock('@/lib/windows-terminal-capabilities', () => ({
  useWindowsTerminalCapabilities: () => ({ wslDistros: [], isLoading: false }),
  getWindowsTerminalCapabilityOwnerKey: () => 'local'
}))
vi.mock('./tooltip', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ProviderIcon: () => null,
  ProviderPanel: () => null
}))

// Why: Radix portals its menu behind pointer-capture the DOM shim cannot drive;
// passthrough shells render the same tree eagerly so the real handlers run.
vi.mock('@/components/ui/dropdown-menu', () => {
  const passthrough =
    (role?: string) =>
    ({
      children,
      onSelect
    }: {
      children?: React.ReactNode
      onSelect?: (event: { preventDefault: () => void }) => void
    }): React.JSX.Element =>
      React.createElement(
        'div',
        {
          role,
          onClick: onSelect ? () => onSelect({ preventDefault: () => {} }) : undefined
        },
        children
      )
  return {
    DropdownMenu: passthrough(),
    DropdownMenuCheckboxItem: passthrough(),
    DropdownMenuContent: passthrough(),
    DropdownMenuItem: passthrough('menuitem'),
    DropdownMenuLabel: passthrough(),
    DropdownMenuSeparator: passthrough(),
    DropdownMenuSub: passthrough(),
    DropdownMenuSubContent: passthrough(),
    DropdownMenuSubTrigger: passthrough(),
    DropdownMenuTrigger: passthrough()
  }
})

vi.mock('../../store', () => {
  const state = (): Record<string, unknown> => ({
    settings: { ...storeSettings, activeRuntimeEnvironmentId },
    runtimeEnvironments: [],
    usagePercentageDisplay: 'used',
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    fetchSettings,
    recordFeatureInteraction: vi.fn(),
    refreshClaudeRateLimitsForTarget: vi.fn(),
    fetchInactiveClaudeAccountUsage: vi.fn(),
    rateLimits: { inactiveClaudeAccounts: [], claudeTarget: { runtime: 'host', wslDistro: null } }
  })
  const useAppStore = (selector: (value: Record<string, unknown>) => unknown): unknown =>
    selector(state())
  useAppStore.getState = state
  return { useAppStore }
})

const claudeProvider: ProviderRateLimits = {
  provider: 'claude',
  session: null,
  weekly: null,
  status: 'ok',
  error: null,
  updatedAt: 1
}

async function openAccounts(): Promise<void> {
  const { ClaudeSwitcherMenu } = await import('./ClaudeSwitcherMenu')
  render(
    React.createElement(ClaudeSwitcherMenu, {
      claude: claudeProvider,
      compact: false,
      iconOnly: false
    })
  )
  // A remote server's roster arrives with the snapshot, not settings.
  fireEvent.click(await screen.findByText('old@example.com'))
  await waitFor(() => expect(screen.getAllByText('old@example.com').length).toBe(2))
}

describe('status bar Claude account that needs a sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeRuntimeEnvironmentId = null
    storeSettings = {
      ...getDefaultSettings('/home/me'),
      claudeManagedAccounts: [account('old'), account('new')],
      activeClaudeManagedAccountId: 'old',
      activeClaudeManagedAccountIdsByRuntime: { host: 'old', wsl: {} }
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { claudeAccounts: { reauthenticate } }
    })
  })

  afterEach(() => cleanup())

  it('marks it and signs in to it inline, without selecting anything', async () => {
    await openAccounts()
    expect(screen.getByText('Sign in again to use this account')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }))
    await waitFor(() => expect(reauthenticate).toHaveBeenCalledWith({ accountId: 'old' }))
    expect(reauthenticate).toHaveBeenCalledTimes(1)
    expect(selectClaudeProviderAccount).not.toHaveBeenCalled()
    await waitFor(() => expect(fetchSettings).toHaveBeenCalled())
    expect(toastError).not.toHaveBeenCalled()
  })

  it('says why a failed sign-in failed', async () => {
    reauthenticate.mockRejectedValueOnce(new Error('Claude login exited with code 1.'))
    await openAccounts()
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }))
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
  })

  it('keeps the account list in the usage roster when the selected account needs a sign-in', async () => {
    const { ClaudeSwitcherMenu } = await import('./ClaudeSwitcherMenu')
    const { UsageRosterPanel } = await import('./UsageRosterPanel')
    const { TooltipProvider } = await import('@/components/ui/tooltip')
    const { usageRowSignInOpensSettings } = await import('./usage-provider-settings-target')
    const onSignIn = vi.fn()
    const signedOut: ProviderRateLimits = {
      ...claudeProvider,
      status: 'error',
      error: 'Not signed in',
      usageMetadata: { failureKind: 'missing-credentials' }
    }
    render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(UsageRosterPanel, {
          providers: [signedOut],
          display: 'used',
          statusBarUsageMode: 'verbose',
          onStatusBarUsageModeChange: () => {},
          isRefreshing: false,
          onRefresh: () => {},
          onOpenProvider: () => {},
          onSignIn,
          canSignIn: (provider) => usageRowSignInOpensSettings(provider, storeSettings),
          onManageAccounts: () => {},
          onUsageDetails: () => {},
          renderRow: (p, row) =>
            React.createElement(ClaudeSwitcherMenu, {
              claude: p,
              compact: false,
              iconOnly: false,
              asSubmenu: true,
              triggerContent: row
            })
        })
      )
    )
    fireEvent.click(await screen.findByText('old@example.com'))
    expect(await screen.findByText('Sign in again to use this account')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }))
    await waitFor(() => expect(reauthenticate).toHaveBeenCalledWith({ accountId: 'old' }))
    expect(onSignIn).not.toHaveBeenCalled()
  })

  it('offers no sign-in on a remote server, which this device cannot sign in for', async () => {
    activeRuntimeEnvironmentId = 'env-1'
    await openAccounts()
    expect(screen.queryByRole('button', { name: /Sign in/ })).toBeNull()
    expect(screen.getByText('Sign in again to use this account')).toBeTruthy()
  })
})
