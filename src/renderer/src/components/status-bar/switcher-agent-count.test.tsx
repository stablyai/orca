// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../shared/constants'
import type {
  ClaudeManagedAccount,
  CodexManagedAccount
} from '../../../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { AgentRunAccount } from '../../../../shared/agent-run-account'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const LEAF = '11111111-1111-4111-8111-111111111111'
let storeSettings: GlobalSettings
let activeRuntimeEnvironmentId: string | null = null

function claudeAccount(id: string): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

function codexAccount(id: string): CodexManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath: '/unused',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

function row(tabId: string, runAccount: AgentRunAccount) {
  const paneKey = makePaneKey(tabId, LEAF)
  return [
    paneKey,
    {
      state: 'working',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      paneKey,
      stateHistory: [],
      connectionId: null,
      runAccount
    }
  ] as const
}

const ROWS = Object.fromEntries([
  row('t1', { provider: 'claude', lane: 'host', accountId: 'work', mode: 'kept' }),
  row('t2', { provider: 'claude', lane: 'host', accountId: 'work', mode: 'follow' }),
  row('t3', { provider: 'codex', lane: 'host', accountId: 'work', mode: 'follow' })
])
const TABS = {
  wt: ['t1', 't2', 't3'].map((id) => ({ id, title: id, customTitle: null, color: null }))
}

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/codex-session-restart', () => ({
  markLiveCodexSessionsForRestart: vi.fn(async () => {}),
  resolveCodexRestartPromptAccountLabel: () => 'System default'
}))
vi.mock('@/runtime/runtime-provider-accounts-client', () => ({
  fetchProviderAccountsSnapshot: vi.fn(async () => ({
    claude: {
      accounts: [claudeAccount('work'), claudeAccount('home')],
      activeAccountId: 'home',
      activeAccountIdsByRuntime: { host: 'home', wsl: {} }
    },
    codex: {
      accounts: [codexAccount('work'), codexAccount('home')],
      activeAccountId: 'home',
      activeAccountIdsByRuntime: { host: 'home', wsl: {} }
    },
    failedProviders: []
  })),
  selectClaudeProviderAccount: vi.fn(),
  selectCodexProviderAccount: vi.fn()
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
// Why: Radix portals its menu behind pointer-capture the DOM shim cannot drive.
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
        { role, onClick: onSelect ? () => onSelect({ preventDefault: () => {} }) : undefined },
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
    fetchSettings: vi.fn(async () => {}),
    updateSettings: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    refreshClaudeRateLimitsForTarget: vi.fn(),
    refreshCodexRateLimitsForTarget: vi.fn(),
    fetchInactiveClaudeAccountUsage: vi.fn(),
    fetchInactiveCodexAccountUsage: vi.fn(async () => {}),
    consumeCodexRateLimitResetCredit: vi.fn(),
    rateLimits: {
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [],
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null }
    },
    agentStatusByPaneKey: ROWS,
    tabsByWorktree: TABS
  })
  const useAppStore = (selector: (value: Record<string, unknown>) => unknown): unknown =>
    selector(state())
  useAppStore.getState = state
  return { useAppStore }
})

function provider(name: 'claude' | 'codex'): ProviderRateLimits {
  return { provider: name, session: null, weekly: null, status: 'ok', error: null, updatedAt: 1 }
}

async function openClaude(): Promise<void> {
  const { ClaudeSwitcherMenu } = await import('./ClaudeSwitcherMenu')
  render(
    React.createElement(ClaudeSwitcherMenu, {
      claude: provider('claude'),
      compact: false,
      iconOnly: false
    })
  )
  fireEvent.click(await screen.findByText('home@example.com'))
  await waitFor(() => expect(screen.getByText('work@example.com')).toBeTruthy())
}

async function openCodex(): Promise<void> {
  const { CodexSwitcherMenu } = await import('./StatusBar')
  render(
    React.createElement(CodexSwitcherMenu, {
      codex: provider('codex'),
      compact: false,
      iconOnly: false
    })
  )
  fireEvent.click(await screen.findByText('home@example.com'))
  await waitFor(() => expect(screen.getByText('work@example.com')).toBeTruthy())
}

describe('terminal agent counts in the account switchers', () => {
  beforeEach(() => {
    activeRuntimeEnvironmentId = null
    storeSettings = {
      ...getDefaultSettings('/home/user'),
      claudeManagedAccounts: [claudeAccount('work'), claudeAccount('home')],
      activeClaudeManagedAccountId: 'home',
      codexManagedAccounts: [codexAccount('work'), codexAccount('home')],
      activeCodexManagedAccountId: 'home'
    }
  })

  afterEach(() => cleanup())

  it('counts Claude terminal agents per account', async () => {
    await openClaude()
    expect(screen.getByText('2 terminal agents')).toBeTruthy()
  })

  it('counts Codex terminal agents per account', async () => {
    await openCodex()
    expect(screen.getByText('1 terminal agent')).toBeTruthy()
  })

  it("never counts this host's agents against a remote server's accounts", async () => {
    activeRuntimeEnvironmentId = 'remote-1'
    await openClaude()
    expect(screen.queryByText('2 terminal agents')).toBeNull()
  })
})
