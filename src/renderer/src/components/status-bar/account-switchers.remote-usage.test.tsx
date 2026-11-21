// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { createEmptyRateLimitState } from '../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type * as ProviderAccountsClient from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  useOwnerUsageRateLimits,
  type OwnerUsageRateLimits
} from './usage/use-owner-usage-rate-limits'
import { CodexSwitcherMenu } from './accounts/CodexSwitcherMenu'
import { ClaudeSwitcherMenu } from './accounts/ClaudeSwitcherMenu'
import { TooltipProvider } from '@/components/ui/tooltip'

const mocks = vi.hoisted(() => {
  const watchers: {
    target: RuntimeClientTarget
    handlers: Parameters<typeof ProviderAccountsClient.watchProviderAccounts>[1]
  }[] = []
  return {
    state: vi.fn<() => ReturnType<typeof localState>>(),
    accounts: vi.fn<() => ProviderAccountsSnapshot>(),
    owner: { kind: 'environment', environmentId: 'laptop' } satisfies RuntimeClientTarget,
    fetchInactive: vi.fn(),
    consumeHostReset: vi.fn(async () => {}),
    watchers
  }
})

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: ReturnType<typeof localState>) => unknown) =>
    selector(mocks.state())
}))
vi.mock('@/runtime/provider-accounts/ownership/use-active-account-owner', () => ({
  useActiveAccountOwner: () => ({ target: mocks.owner, wslHostDistro: null })
}))
vi.mock('@/runtime/hosts/capabilities/windows-terminal-capabilities', () => ({
  getWindowsTerminalCapabilityOwnerKey: () => 'laptop',
  useWindowsTerminalCapabilities: () => ({ wslDistros: [] })
}))
vi.mock(
  '@/runtime/provider-accounts/observations/runtime-provider-accounts-client',
  async (load) => ({
    ...(await load<typeof ProviderAccountsClient>()),
    fetchProviderAccountsSnapshot: async () => mocks.accounts(),
    watchProviderAccounts: (
      target: RuntimeClientTarget,
      handlers: Parameters<typeof ProviderAccountsClient.watchProviderAccounts>[1]
    ) => {
      mocks.watchers.push({ target, handlers })
      return { close: () => {} }
    }
  })
)

vi.mock('@/runtime/provider-accounts/usage/runtime-codex-reset-credit-client', () => ({
  hostSupportsCodexResetCredit: async () => true,
  hasUnansweredHostCodexReset: () => false,
  consumeHostCodexResetCredit: mocks.consumeHostReset
}))

function usage(usedPercent: number): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: { usedPercent, windowMinutes: 10080, resetsAt: null, resetDescription: null },
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

function localState() {
  return {
    settings: getDefaultSettings('/viewer'),
    runtimeEnvironments: [{ id: 'laptop', name: 'Laptop' }],
    rateLimits: createEmptyRateLimitState({
      codex: usage(91),
      codexTarget: { runtime: 'wsl', wslDistro: 'Viewer Linux' },
      inactiveCodexAccounts: [
        { accountId: 'same-id', rateLimits: usage(99), updatedAt: 1, isFetching: false }
      ]
    }),
    usagePercentageDisplay: 'used',
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    fetchSettings: vi.fn(),
    updateSettings: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    refreshCodexRateLimitsForTarget: vi.fn(),
    consumeCodexRateLimitResetCredit: vi.fn(),
    fetchInactiveCodexAccountUsage: mocks.fetchInactive,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    codexRestartNoticeByPtyId: {}
  }
}

function ownerUsage(): OwnerUsageRateLimits & { accounts: ProviderAccountsSnapshot } {
  const accounts = {
    accounts: [
      {
        id: 'active-id',
        email: 'active@laptop.test',
        managedHomePath: '/laptop/active',
        providerAccountId: 'active',
        workspaceLabel: null,
        workspaceAccountId: null,
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      },
      {
        id: 'same-id',
        email: 'other@laptop.test',
        managedHomePath: '/laptop/other',
        providerAccountId: 'other',
        workspaceLabel: null,
        workspaceAccountId: null,
        createdAt: 1,
        updatedAt: 1,
        lastAuthenticatedAt: 1
      }
    ],
    activeAccountId: 'active-id',
    activeAccountIdsByRuntime: { host: 'active-id', wsl: {} }
  }
  const rateLimits = createEmptyRateLimitState({
    codex: usage(4),
    inactiveCodexAccounts: [
      { accountId: 'same-id', rateLimits: usage(25), updatedAt: 1, isFetching: false }
    ]
  })
  return {
    owner: { target: mocks.owner, wslHostDistro: null },
    rateLimits,
    accounts: { claude: { accounts: [], activeAccountId: null }, codex: accounts, rateLimits },
    accountsUnverifiable: false,
    remoteOwner: { environmentId: 'laptop', label: 'Laptop' },
    refreshRemote: null
  }
}

async function showMenu(owned: OwnerUsageRateLimits) {
  render(<CodexSwitcherMenu codex={usage(4)} ownerUsage={owned} />)
  return openMenu()
}

async function openMenu() {
  fireEvent.pointerDown(
    screen.getByRole('button', { name: 'Open Codex details and account switcher' }),
    { button: 0, ctrlKey: false }
  )
  return screen.findByRole('menuitem', { name: /other@laptop.test/ })
}

beforeEach(() => {
  mocks.watchers.length = 0
  mocks.fetchInactive.mockClear()
  mocks.state.mockReturnValue(localState())
  const accounts = ownerUsage().accounts
  if (!accounts) {
    throw new Error('Missing test account roster')
  }
  mocks.accounts.mockReturnValue(accounts)
})
afterEach(cleanup)

describe('Codex account usage on a paired host', () => {
  it('does not use the viewer quota when the host has not reported an inactive account', async () => {
    const owned = ownerUsage()
    owned.rateLimits.inactiveCodexAccounts = []
    const other = await showMenu(owned)
    expect(within(other).queryByRole('img')).toBeNull()
  })

  it('stops claiming cached inactive quotas when the owner cannot be verified', async () => {
    const owned = ownerUsage()
    if (!owned.rateLimits.codex) {
      throw new Error('Missing test usage')
    }
    owned.rateLimits.codex.usageMetadata = { unverifiableOwner: true }
    const other = await showMenu(owned)
    expect(within(other).queryByRole('img')).toBeNull()
  })

  it('keeps the account identity and quota together when another client switches the host account', async () => {
    function ObservedMenu() {
      const owned = useOwnerUsageRateLimits(mocks.state().rateLimits)
      return <CodexSwitcherMenu codex={owned.rateLimits.codex ?? usage(0)} ownerUsage={owned} />
    }
    render(<ObservedMenu />)
    const { handlers } = mocks.watchers[0]
    act(() => handlers.onSnapshot(ownerUsage().accounts))
    const other = await openMenu()
    const active = screen.getByRole('menuitem', { name: /active@laptop.test/ })
    expect(within(other).getByRole('img').getAttribute('aria-label')).toContain('25%')
    expect(within(active).getByRole('img').getAttribute('aria-label')).toContain('4%')
    expect(screen.queryByRole('img', { name: /99%|91%/ })).toBeNull()
    const next = ownerUsage().accounts
    next.codex.activeAccountId = 'same-id'
    next.codex.activeAccountIdsByRuntime = { host: 'same-id', wsl: {} }
    next.rateLimits = createEmptyRateLimitState({
      codex: usage(25),
      inactiveCodexAccounts: [
        { accountId: 'active-id', rateLimits: usage(4), updatedAt: 1, isFetching: false }
      ]
    })
    act(() => handlers.onSnapshot(next))
    const previous = screen.getByRole('menuitem', { name: /active@laptop.test/ })
    const current = screen.getByRole('menuitem', { name: /other@laptop.test/ })
    expect(within(previous).getByRole('img').getAttribute('aria-label')).toContain('4%')
    expect(within(current).getByRole('img').getAttribute('aria-label')).toContain('25%')
    expect(current.getAttribute('aria-disabled')).toBe('true')
    expect(previous.getAttribute('aria-disabled')).not.toBe('true')
  })

  it('does not offer a viewer-backed runtime switch for a host with WSL accounts', async () => {
    const owned = ownerUsage()
    owned.accounts.codex.accounts.push({
      ...owned.accounts.codex.accounts[0],
      id: 'linux-id',
      email: 'linux@laptop.test',
      managedHomeRuntime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    mocks.accounts.mockReturnValue(owned.accounts)
    await showMenu(owned)
    expect(screen.queryByRole('radiogroup', { name: 'Codex usage runtime' })).toBeNull()
    const active = screen.getByRole('menuitem', { name: /active@laptop.test/ })
    expect(within(active).getByRole('img').getAttribute('aria-label')).toContain('4%')
    expect(screen.queryByRole('menuitem', { name: /linux@laptop.test/ })).toBeNull()
  })

  it('redeems a reset on the host for the host account it shows', async () => {
    mocks.state.mockReturnValue({
      ...localState(),
      settings: { ...getDefaultSettings('/viewer'), skipCodexRateLimitResetConfirm: true }
    })
    const owned = ownerUsage()
    const codex = { ...usage(4), rateLimitResetCredits: { availableCount: 1, nextExpiresAt: null } }
    owned.rateLimits.codex = codex
    render(<CodexSwitcherMenu codex={codex} ownerUsage={owned} />)
    await openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reset now' }))
    await vi.waitFor(() =>
      expect(mocks.consumeHostReset).toHaveBeenCalledWith('laptop', {
        target: { runtime: 'host', wslDistro: null },
        accountId: 'active-id',
        accountRevision: 1,
        offerRevision: expect.stringMatching(/^v1:/)
      })
    )
  })
})

function claudeAccount(id: string, email: string) {
  return {
    id,
    email,
    authMethod: 'subscription-oauth' as const,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

describe('Claude account usage on a paired host', () => {
  it('shows host active and inactive quotas, never the viewer store, for a colliding account id', async () => {
    mocks.state.mockReturnValue({
      ...localState(),
      rateLimits: createEmptyRateLimitState({
        claude: { ...usage(91), provider: 'claude' },
        inactiveClaudeAccounts: [
          {
            accountId: 'same-id',
            rateLimits: { ...usage(99), provider: 'claude' },
            updatedAt: 1,
            isFetching: false
          }
        ]
      }),
      fetchInactiveClaudeAccountUsage: vi.fn(),
      refreshClaudeRateLimitsForTarget: vi.fn()
    })
    const owned = ownerUsage()
    owned.accounts.claude = {
      accounts: [
        claudeAccount('active-id', 'active@laptop.test'),
        claudeAccount('same-id', 'other@laptop.test')
      ],
      activeAccountId: 'active-id',
      activeAccountIdsByRuntime: { host: 'active-id', wsl: {} }
    }
    const claude: ProviderRateLimits = { ...usage(4), provider: 'claude' }
    owned.rateLimits.claude = claude
    owned.rateLimits.inactiveClaudeAccounts = [
      {
        accountId: 'same-id',
        rateLimits: { ...usage(25), provider: 'claude' },
        updatedAt: 1,
        isFetching: false
      },
      {
        accountId: 'claude-system-default',
        rateLimits: { ...usage(37), provider: 'claude' },
        updatedAt: 1,
        isFetching: false
      }
    ]
    render(<ClaudeSwitcherMenu claude={claude} ownerUsage={owned} />)
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'Open Claude details and account switcher' }),
      { button: 0, ctrlKey: false }
    )
    const other = await screen.findByRole('menuitem', { name: /other@laptop.test/ })
    expect(within(other).getByRole('img').getAttribute('aria-label')).toContain('25%')
    const active = screen.getByRole('menuitem', { name: /active@laptop.test/ })
    expect(within(active).getByRole('img').getAttribute('aria-label')).toContain('4%')
    const systemDefault = screen.getByRole('menuitem', { name: /System default/ })
    expect(within(systemDefault).getByRole('img').getAttribute('aria-label')).toContain('37%')
    expect(screen.queryByRole('img', { name: /99%|91%/ })).toBeNull()
  })
})

describe('Claude account rows outside the status bar owner', () => {
  function claudeOwner(): ReturnType<typeof ownerUsage> {
    const owned = ownerUsage()
    owned.accounts.claude = {
      accounts: [
        claudeAccount('active-id', 'active@laptop.test'),
        claudeAccount('same-id', 'other@laptop.test')
      ],
      activeAccountId: 'active-id',
      activeAccountIdsByRuntime: { host: 'active-id', wsl: {} }
    }
    owned.rateLimits.inactiveClaudeAccounts = [
      {
        accountId: 'same-id',
        rateLimits: { ...usage(25), provider: 'claude' },
        updatedAt: 1,
        isFetching: false
      }
    ]
    return owned
  }

  beforeEach(() => {
    mocks.state.mockReturnValue({
      ...localState(),
      fetchInactiveClaudeAccountUsage: vi.fn(),
      refreshClaudeRateLimitsForTarget: vi.fn()
    })
  })

  it("shows a server chat's per-account usage from that server", async () => {
    const target = { kind: 'environment', environmentId: 'chat-host' } as const
    render(
      <TooltipProvider>
        <ClaudeSwitcherMenu
          claude={null}
          iconOnly
          chatAction={{ target, canSwitch: async () => true }}
        />
      </TooltipProvider>
    )
    const snapshot = claudeOwner().accounts
    expect(mocks.watchers.map((watcher) => watcher.target)).toEqual([target])
    act(() => mocks.watchers[0].handlers.onSnapshot(snapshot))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Switch account' }), {
      button: 0,
      ctrlKey: false
    })
    const other = await screen.findByRole('menuitem', { name: /other@laptop.test/ })
    expect(within(other).getByRole('img').getAttribute('aria-label')).toContain('25%')
  })
})
