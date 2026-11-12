// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type * as ProviderAccountsClient from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { OwnerUsageRateLimits } from './use-owner-usage-rate-limits'
import { CodexSwitcherMenu } from './CodexSwitcherMenu'

const mocks = vi.hoisted(() => ({
  state: vi.fn<() => ReturnType<typeof localState>>(),
  accounts: vi.fn<() => ProviderAccountsSnapshot>(),
  owner: { kind: 'environment', environmentId: 'laptop' } satisfies RuntimeClientTarget,
  fetchInactive: vi.fn()
}))

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
vi.mock('./use-provider-account-list', () => ({
  useProviderAccountList: () => ({
    accounts: mocks.accounts().codex,
    setAccounts: vi.fn(),
    mountedRef: { current: true }
  })
}))
vi.mock(
  '@/runtime/provider-accounts/observations/runtime-provider-accounts-client',
  async (load) => ({
    ...(await load<typeof ProviderAccountsClient>()),
    fetchProviderAccountsSnapshot: async () => mocks.accounts()
  })
)

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

function ownerUsage() {
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
    rateLimits,
    accounts: { claude: { accounts: [], activeAccountId: null }, codex: accounts, rateLimits },
    remoteOwner: { environmentId: 'laptop', label: 'Laptop' },
    refreshRemote: null
  }
}

async function showMenu(owned: OwnerUsageRateLimits) {
  render(<CodexSwitcherMenu codex={usage(4)} ownerUsage={owned} compact={false} iconOnly={false} />)
  fireEvent.pointerDown(
    screen.getByRole('button', { name: 'Open Codex details and account switcher' }),
    { button: 0, ctrlKey: false }
  )
  return screen.findByRole('menuitem', { name: /other@laptop.test/ })
}

beforeEach(() => {
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
  it('shows host active and inactive quotas even when the viewer uses a different runtime and colliding account id', async () => {
    const other = await showMenu(ownerUsage())
    expect(within(other).getByRole('img').getAttribute('aria-label')).toContain('25%')
    const active = screen.getByRole('menuitem', { name: /active@laptop.test/ })
    expect(within(active).getByRole('img').getAttribute('aria-label')).toContain('4%')
    expect(screen.queryByRole('img', { name: /99%|91%/ })).toBeNull()
  })

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
})
