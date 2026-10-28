// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { AccountsPane } from './AccountsPane'
import type { SettingsHostScope } from './settings-host-scope'

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
  <AccountsPane settings={focusedElsewhere} updateSettings={vi.fn()} hostScope={scope} />
)

const fake = vi.hoisted(() => {
  const state: {
    pendingSelect: ((roster: unknown) => void) | null
    write: ReturnType<typeof vi.fn>
    rosters: Map<string, unknown>
    watchedTargets: unknown[]
    selects: unknown[][]
  } = {
    pendingSelect: null,
    write: vi.fn(),
    rosters: new Map(),
    watchedTargets: [],
    selects: []
  }
  return state
})
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settingsSearchQuery: 'claude',
      rateLimits: {
        codex: null,
        codexTarget: { runtime: 'host', wslDistro: null },
        minimax: null,
        cursor: { updatedAt: 0 },
        grok: { updatedAt: 0 }
      },
      runtimeEnvironments: [],
      recordFeatureInteraction: fake.write,
      fetchSettings: fake.write
    })
}))
vi.mock('@/runtime/runtime-provider-accounts-client', () => {
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

beforeEach(() => {
  fake.pendingSelect = null
  fake.watchedTargets = []
  fake.selects = []
  fake.rosters.set('local', claudeRoster('acct-l', 'local@desktop.test', false))
  fake.rosters.set('server-a', claudeRoster('acct-a', 'alpha@server-a.test', false))
  fake.rosters.set('server-b', claudeRoster('acct-b', 'beta@server-b.test', false))
  Object.assign(window, {
    api: {
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
  Reflect.deleteProperty(window, 'api')
})

it('lists the accounts of the host chosen in the page, not the focused server', async () => {
  render(renderPane(scopeFor(null)))
  await act(async () => {})
  expect(screen.getByText('local@desktop.test')).toBeTruthy()
  expect(fake.watchedTargets).toEqual([{ kind: 'local' }])
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

it("shows a WSL host's distro accounts from this desktop and selects for that distro", async () => {
  const roster = claudeRoster('acct-w', 'wsl@ubuntu.test', false)
  roster.accounts = roster.accounts.map((account) => ({
    ...account,
    managedAuthRuntime: 'wsl',
    wslDistro: 'Ubuntu'
  }))
  fake.rosters.set('local', roster)
  render(
    <AccountsPane
      settings={focusedElsewhere}
      updateSettings={vi.fn()}
      hostScope={scopeFor(null)}
      wslHostDistro="Ubuntu"
      wslSupportedPlatform
      wslAvailable
      wslDistros={['Ubuntu']}
    />
  )
  await act(async () => {})
  expect(fake.watchedTargets).toEqual([{ kind: 'local' }])
  fireEvent.click(screen.getByText('wsl@ubuntu.test'))
  expect(fake.selects).toEqual([
    [{ kind: 'local' }, { accountId: 'acct-w', runtime: 'wsl', wslDistro: 'Ubuntu' }]
  ])
})
