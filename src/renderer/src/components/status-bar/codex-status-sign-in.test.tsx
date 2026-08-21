// @vitest-environment happy-dom
/**
 * STA-4422 symptom 2: the status bar's inline "Sign in" action re-authenticated
 * an account and then reported nothing — no toast on success or failure — and
 * never ran the session-restart workflow that an explicit account switch runs,
 * so live panes kept the old credentials. These render the real switcher and
 * click the real button so the wiring (intent flag, runtime target, restart
 * workflow, toasts) cannot pass while the handler is mis-wired.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type {
  CodexManagedAccountSummary,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

const markLiveCodexSessionsForRestart = vi.fn(async () => {})
const toastSuccess = vi.fn()
const toastError = vi.fn()
const fetchInactiveCodexAccountUsage = vi.fn(async () => {})
const fetchSettings = vi.fn(async () => {})
const reauthenticate = vi.fn(async (_args: unknown) => codexSnapshot(null))

let storeSettings: GlobalSettings

function codexAccount(id: string, updatedAt: number): CodexManagedAccountSummary {
  return {
    id,
    email: `${id}@example.com`,
    managedHomeRuntime: 'host',
    wslDistro: null,
    providerAccountId: `provider-${id}`,
    workspaceLabel: null,
    workspaceAccountId: null,
    createdAt: updatedAt,
    updatedAt,
    lastAuthenticatedAt: updatedAt
  }
}

function codexSnapshot(activeAccountId: string | null): CodexRateLimitAccountsState {
  return {
    accounts: [codexAccount('account-1', 2), codexAccount('account-2', 1)],
    activeAccountId,
    activeAccountIdsByRuntime: { host: activeAccountId, wsl: {} }
  }
}

function settingsWithActive(activeAccountId: string | null): GlobalSettings {
  return {
    codexManagedAccounts: [codexAccount('account-1', 2), codexAccount('account-2', 1)],
    activeCodexManagedAccountId: activeAccountId,
    activeCodexManagedAccountIdsByRuntime: { host: activeAccountId, wsl: {} },
    claudeManagedAccounts: [],
    activeClaudeManagedAccountId: null,
    localAccountRuntime: 'host',
    localAccountWslDistro: null,
    skipCodexRateLimitResetConfirm: false
  } as unknown as GlobalSettings
}

/** An inactive account whose usage probe failed — the state that renders "Sign in". */
const unavailableUsage: ProviderRateLimits = {
  provider: 'codex',
  session: null,
  weekly: null,
  status: 'error',
  error: 'Not signed in',
  updatedAt: 1
} as unknown as ProviderRateLimits

vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError }
}))

vi.mock('@/lib/codex-session-restart', () => ({
  markLiveCodexSessionsForRestart,
  resolveCodexRestartPromptAccountLabel: (
    accounts: readonly { id: string; email: string }[],
    accountId: string | null | undefined
  ) => accounts.find((entry) => entry.id === accountId)?.email ?? 'System default'
}))

vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot: vi.fn(async () => ({
    codex: codexSnapshot(null),
    claude: { accounts: [], activeAccountId: null },
    failedProviders: []
  })),
  selectCodexProviderAccount: vi.fn(async () => codexSnapshot(null)),
  selectClaudeProviderAccount: vi.fn(async () => ({ accounts: [], activeAccountId: null }))
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => null
}))

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
    settings: storeSettings,
    runtimeEnvironments: [],
    usagePercentageDisplay: 'used',
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    fetchSettings,
    updateSettings: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    refreshCodexRateLimitsForTarget: vi.fn(),
    consumeCodexRateLimitResetCredit: vi.fn(),
    fetchInactiveCodexAccountUsage,
    rateLimits: {
      inactiveCodexAccounts: [
        { accountId: 'account-2', isFetching: false, rateLimits: unavailableUsage }
      ],
      codexTarget: { runtime: 'host', wslDistro: null }
    }
  })
  const useAppStore = (selector: (value: Record<string, unknown>) => unknown): unknown =>
    selector(state())
  useAppStore.getState = state
  return { useAppStore }
})

const codexProvider: ProviderRateLimits = {
  provider: 'codex',
  session: null,
  weekly: null,
  status: 'error',
  error: 'Not signed in',
  updatedAt: 1
} as unknown as ProviderRateLimits

async function renderSwitcherAndOpenAccounts(summaryLabel: string): Promise<void> {
  const { CodexSwitcherMenu } = await import('./StatusBar')
  render(
    React.createElement(CodexSwitcherMenu, {
      codex: codexProvider,
      compact: false,
      iconOnly: false
    })
  )
  // The account list is collapsed behind the summary row, exactly as in the app.
  fireEvent.click(screen.getByText(summaryLabel))
  await waitFor(() => expect(screen.getByRole('button', { name: /Sign in/ })).toBeTruthy())
}

describe('status bar Codex sign-in action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeSettings = settingsWithActive(null)
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: { codexAccounts: { reauthenticate } }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('activates the signed-in account and runs the same restart workflow a switch runs', async () => {
    reauthenticate.mockResolvedValue(codexSnapshot('account-2'))

    await renderSwitcherAndOpenAccounts('System default')
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }))

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
    // Healthy anchor: the intent and the clicked row's lane both reach the main process.
    expect(reauthenticate).toHaveBeenCalledWith({
      accountId: 'account-2',
      activateIfSelectionWasEmpty: true
    })
    expect(markLiveCodexSessionsForRestart).toHaveBeenCalledTimes(1)
    expect(markLiveCodexSessionsForRestart).toHaveBeenCalledWith(
      expect.objectContaining({
        previousAccountId: null,
        nextAccountId: 'account-2',
        target: { runtime: 'host', wslDistro: null }
      })
    )
    expect(toastError).not.toHaveBeenCalled()
  })

  it('does not disturb live panes when the effective account did not change', async () => {
    storeSettings = settingsWithActive('account-1')
    reauthenticate.mockResolvedValue(codexSnapshot('account-1'))

    await renderSwitcherAndOpenAccounts('account-1@example.com')
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }))

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
    // Healthy anchor: the same click reached the main process; only the follow-up differs.
    expect(reauthenticate).toHaveBeenCalledWith({
      accountId: 'account-2',
      activateIfSelectionWasEmpty: true
    })
    expect(markLiveCodexSessionsForRestart).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('reports a failed sign-in instead of leaving the click silent', async () => {
    reauthenticate.mockRejectedValue(new Error('Codex login exited with code 1.'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await renderSwitcherAndOpenAccounts('System default')
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }))

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(markLiveCodexSessionsForRestart).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
