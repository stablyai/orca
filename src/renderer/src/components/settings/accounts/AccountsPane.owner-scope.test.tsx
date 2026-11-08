// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { i18n } from '@/i18n/i18n'
import { getDefaultSettings } from '../../../../../shared/constants'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../../../shared/managed-account-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { AccountsPane } from './AccountsPane'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import type { SettingsNavigationTarget } from '@/lib/settings-navigation-types'

// Why: focus deliberately points at another server; the pane must follow hostScope only.
const focusedElsewhere = {
  ...getDefaultSettings('/synthetic'),
  activeRuntimeEnvironmentId: 'focused-server'
}
const scopeFor = (environmentId: string | null): SettingsHostScope => ({
  target: environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
  available: true
})
const renderPane = (scope: SettingsHostScope): React.JSX.Element => (
  <AccountsPane
    settings={focusedElsewhere}
    updateSettings={vi.fn()}
    updateSettingsOrThrow={vi.fn()}
    hostScope={scope}
  />
)

const fake = vi.hoisted(() => {
  const state: {
    query: string
    pendingSelect: ((roster: unknown) => void) | null
    write: ReturnType<typeof vi.fn>
    add: ReturnType<typeof vi.fn>
    navigate: (target: SettingsNavigationTarget) => void
    rosters: Map<string, unknown>
    watchedTargets: unknown[]
    selects: unknown[][]
  } = {
    query: 'claude',
    pendingSelect: null,
    write: vi.fn(),
    add: vi.fn(),
    navigate: () => {},
    rosters: new Map(),
    watchedTargets: [],
    selects: []
  }
  return state
})
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))
vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settingsSearchQuery: fake.query,
      settings: focusedElsewhere,
      openSettingsTarget: (target: SettingsNavigationTarget) => fake.navigate(target),
      openSettingsPage: fake.write,
      rateLimits: {
        codex: null,
        codexTarget: { runtime: 'host', wslDistro: null },
        minimax: null,
        cursor: { updatedAt: 0 },
        grok: { updatedAt: 0 },
        inactiveClaudeAccounts: [],
        claudeTarget: { runtime: 'host', wslDistro: null }
      },
      runtimeEnvironments: [],
      runtimeStatusByEnvironmentId: new Map(),
      recordFeatureInteraction: fake.write,
      fetchSettings: fake.write,
      fetchInactiveClaudeAccountUsage: fake.write
    })
}))
vi.mock('@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client', () => ({
  callAntigravityAccounts: vi.fn(),
  callAntigravityChatSignIn: vi.fn(),
  subscribeAntigravityChatSignIn: vi.fn()
}))
vi.mock('@/runtime/provider-accounts/observations/runtime-provider-accounts-client', () => {
  const empty = () => ({
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  })
  return {
    emptyClaudeAccountsState: empty,
    emptyCodexAccountsState: empty,
    getProviderAccountsOwnerKey: (target: RuntimeClientTarget) =>
      target.kind === 'environment' ? target.environmentId : 'local',
    watchProviderAccounts: (
      target: RuntimeClientTarget,
      handlers: { onSnapshot: (snapshot: unknown) => void }
    ) => {
      fake.watchedTargets.push(target)
      handlers.onSnapshot({
        claude: fake.rosters.get(target.kind === 'environment' ? target.environmentId : 'local'),
        codex: empty(),
        rateLimits: null
      })
      return { close: vi.fn() }
    },
    fetchProviderAccountsSnapshot: async (target: RuntimeClientTarget) => ({
      claude: fake.rosters.get(target.kind === 'environment' ? target.environmentId : 'local')
    }),
    selectClaudeProviderAccount: (...args: unknown[]) => {
      fake.selects.push(args)
      return new Promise((resolve) => {
        fake.pendingSelect = resolve
      })
    },
    selectCodexProviderAccount: fake.write,
    removeClaudeProviderAccount: fake.write,
    removeCodexProviderAccount: fake.write
  }
})

function claudeRoster(id: string, email: string, active: boolean): ClaudeRateLimitAccountsState {
  const account: ClaudeManagedAccountSummary = {
    id,
    email,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
  const activeId = active ? id : null
  return {
    accounts: [account],
    activeAccountId: activeId,
    activeAccountIdsByRuntime: { host: activeId, wsl: {} }
  }
}

vi.mock('@/lib/claude-account-switch-sessions', () => ({
  handleRunningClaudeSessionsAfterSwitch: vi.fn(async () => 'no-running-sessions')
}))
vi.mock('../../../runtime/provider-accounts/ownership/use-active-account-owner', () => ({
  useActiveAccountOwner: () => ({ target: { kind: 'local' }, wslHostDistro: null })
}))
vi.mock('@/lib/windows-terminal-capabilities', () => ({
  getWindowsTerminalCapabilityOwnerKey: () => 'local',
  useWindowsTerminalCapabilities: () => ({ wslDistros: ['Ubuntu'] })
}))

beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.mocked(toast.error).mockClear()
  fake.query = 'claude'
  fake.write.mockClear()
  fake.add.mockReset()
  fake.add.mockImplementation(async () => fake.rosters.get('local'))
  fake.pendingSelect = null
  fake.watchedTargets = []
  fake.selects = []
  fake.rosters.set('local', claudeRoster('acct-l', 'local@desktop.test', false))
  fake.rosters.set('server-a', claudeRoster('acct-a', 'alpha@server-a.test', false))
  fake.rosters.set('server-b', claudeRoster('acct-b', 'beta@server-b.test', false))
  Object.assign(window, {
    api: {
      claudeAccounts: { add: fake.add },
      minimaxCredentials: {
        getStatus: vi.fn(async () => ({ cookieConfigured: false, apiKeyConfigured: false }))
      },
      codexConfigSync: {
        status: vi.fn(async () => ({ state: 'synced', reason: null, systemConfigPath: '/x' }))
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'api')
})

it("drops a server's late account result after the page moves to another server", async () => {
  const view = render(renderPane(scopeFor('server-a')))
  await act(async () => {})
  fireEvent.click(screen.getByText('alpha@server-a.test'))
  expect(fake.pendingSelect).not.toBeNull()

  await act(async () => view.rerender(renderPane(scopeFor('server-b'))))
  expect(screen.getByText('beta@server-b.test')).toBeTruthy()

  await act(async () => fake.pendingSelect?.(claudeRoster('acct-a', 'alpha@server-a.test', true)))

  expect(screen.queryByText('alpha@server-a.test')).toBeNull()
  expect(screen.getByText('beta@server-b.test')).toBeTruthy()
})

it('keeps a late account result once the pane is back on the server it was sent to', async () => {
  const view = render(renderPane(scopeFor('server-a')))
  await act(async () => {})
  fireEvent.click(screen.getByText('alpha@server-a.test'))
  for (const environmentId of ['server-b', 'server-a']) {
    await act(async () => view.rerender(renderPane(scopeFor(environmentId))))
  }
  const alphaRow = (): HTMLElement => {
    const row = screen.getByText('alpha@server-a.test').closest('button')
    expect(row).not.toBeNull()
    return row ?? document.body
  }
  expect(within(alphaRow()).queryByText('Active')).toBeNull()

  await act(async () => fake.pendingSelect?.(claudeRoster('acct-a', 'alpha@server-a.test', true)))

  expect(within(alphaRow()).getByText('Active')).toBeTruthy()
})
