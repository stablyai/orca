// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useEffect, useLayoutEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { AccountsPane } from './AccountsPane'
import { useSettingsHostNavigation } from './use-settings-host-navigation'
import { resolveSettingsHostScope } from './settings-host-scope'
import type { SettingsNavigationTarget } from '@/lib/settings-navigation-types'
import { ProviderAccountChatButton } from '../status-bar/ProviderAccountChatButton'
import { ClaudeSwitcherMenu } from '../status-bar/ClaudeSwitcherMenu'
import { TooltipProvider } from '../ui/tooltip'
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
    add: ReturnType<typeof vi.fn>
    query: string
    navigate: (target: SettingsNavigationTarget) => void
    rosters: Map<string, unknown>
    watchedTargets: unknown[]
    selects: unknown[][]
  } = {
    pendingSelect: null,
    write: vi.fn(),
    add: vi.fn(),
    query: 'claude',
    navigate: () => {},
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
        inactiveClaudeAccounts: {},
        claudeTarget: { runtime: 'host', wslDistro: null }
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
vi.mock('@/runtime/use-worktree-runtime-target', () => ({
  useActiveAccountOwner: () => ({ target: { kind: 'local' }, wslHostDistro: null })
}))
vi.mock('@/lib/windows-terminal-capabilities', () => ({
  getWindowsTerminalCapabilityOwnerKey: () => 'local',
  useWindowsTerminalCapabilities: () => ({ wslDistros: ['Ubuntu'] })
}))

beforeEach(() => {
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

  // Server A's roster must not replace server B's in the pane now scoped to B.
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

it.each(['add', 'manage'] as const)(
  '%s navigation keeps native Windows accounts through consumption until explicit navigation releases them',
  async (entry) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows')
    const roster = claudeRoster('native', 'native@windows.test', true)
    roster.accounts.push(
      { ...roster.accounts[0], id: 'native2', email: 'second@windows.test' },
      {
        ...roster.accounts[0],
        id: 'wsl',
        email: 'wsl@ubuntu.test',
        managedAuthRuntime: 'wsl',
        wslDistro: 'Ubuntu'
      }
    )
    fake.rosters.set('local', roster)
    const writeSettings = vi.fn()
    function Visit({
      target,
      clear
    }: {
      target: SettingsNavigationTarget | null
      clear: () => void
    }) {
      const navigation = useSettingsHostNavigation(target)
      const { consumeSettingsNavigation } = navigation
      const [settings, setSettings] = useState<GlobalSettings>({
        ...focusedElsewhere,
        localAccountRuntime: 'wsl' as const,
        localAccountWslDistro: 'Ubuntu'
      })
      const scope = resolveSettingsHostScope({
        choice: navigation.settingsHostChoice,
        defaultEnvironmentId: 'focused-server',
        savedEnvironmentIds: ['focused-server'],
        catalogHydrated: true
      })
      useEffect(() => {
        if (target) {
          consumeSettingsNavigation(target)
          clear()
        }
      }, [target, clear, consumeSettingsNavigation])
      useLayoutEffect(() => {
        // The first possible action precedes consumption effects, even with another default host.
        document.querySelector<HTMLButtonElement>('#accounts-claude button')?.click()
      }, [])
      return (
        <>
          <button onClick={() => navigation.setSettingsHostChoice({ kind: 'local' })}>
            Choose local host
          </button>
          <button
            onClick={() => navigation.consumeSettingsNavigation({ pane: 'accounts', repoId: null })}
          >
            Ordinary accounts
          </button>
          <AccountsPane
            settings={settings}
            updateSettings={async (updates) => {
              await writeSettings(updates)
              setSettings((previous) => ({ ...previous, ...updates }))
            }}
            hostScope={scope}
            nativeAccounts={navigation.nativeAccounts}
            onAccountLocationChange={navigation.releaseNativeAccounts}
            wslSupportedPlatform
            wslAvailable
            wslDistros={['Ubuntu']}
          />
        </>
      )
    }
    function Flow() {
      const [target, setTarget] = useState<SettingsNavigationTarget | null>(null)
      const [opened, setOpened] = useState(false)
      fake.navigate = (next) => {
        setTarget(next)
        setOpened(true)
      }
      return (
        <TooltipProvider>
          {opened ? (
            <>
              <button onClick={() => setOpened(false)}>Close Settings</button>
              <Visit target={target} clear={() => setTarget(null)} />
            </>
          ) : entry === 'add' ? (
            <ProviderAccountChatButton
              provider="claude"
              target={{ kind: 'local' }}
              add
              disabled={false}
            />
          ) : (
            <ClaudeSwitcherMenu
              claude={null}
              compact
              iconOnly={false}
              chatAction={{ target: { kind: 'local' }, canSwitch: async () => true }}
            />
          )}
        </TooltipProvider>
      )
    }
    const view = render(<Flow />)
    const enter = async () => {
      const trigger = await screen.findByRole('button', {
        name: entry === 'add' ? 'Add Account…' : 'Switch Account'
      })
      await waitFor(() => expect(trigger).toBeEnabled())
      if (entry === 'add') {
        fireEvent.click(trigger)
      } else {
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Manage Accounts…' }))
      }
    }
    const add = async () => {
      const section = document.getElementById('accounts-claude')
      if (!section) {
        throw new Error('Missing Claude section')
      }
      const button = within(section).getByRole('button', { name: 'Add Account' })
      await waitFor(() => expect(button).toBeEnabled())
      fireEvent.click(button)
      await act(async () => {})
    }
    await enter()
    await waitFor(() => expect(fake.add).toHaveBeenCalled())
    expect(fake.add.mock.calls[0]).toEqual([
      { runtime: 'host', wslDistro: undefined, copyLink: false }
    ])
    expect(fake.watchedTargets).not.toContainEqual({
      kind: 'environment',
      environmentId: 'focused-server'
    })
    expect(screen.getByText('native@windows.test')).toBeTruthy()
    expect(screen.queryByText('wsl@ubuntu.test')).toBeNull()
    expect(writeSettings).not.toHaveBeenCalled()
    await add()
    expect(fake.add.mock.lastCall?.[0].runtime).toBe('host')
    // The actual picker remains available; only an explicit selection writes the preference.
    fake.query = 'Account Location'
    view.rerender(<Flow />)
    const write = Promise.withResolvers<void>()
    writeSettings.mockReturnValueOnce(write.promise)
    fireEvent.click(screen.getByRole('radio', { name: 'Windows' }))
    expect(screen.getByRole('radio', { name: 'Windows' })).toHaveAttribute('aria-checked', 'true')
    expect(writeSettings).toHaveBeenCalledExactlyOnceWith({ localAccountRuntime: 'host' })
    await act(async () => write.resolve())
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: 'WSL' })))
    expect(writeSettings.mock.lastCall).toEqual([{ localAccountRuntime: 'wsl' }])
    fake.query = 'claude'
    view.rerender(<Flow />)
    await add()
    expect(fake.add.mock.lastCall?.[0]).toMatchObject({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(screen.getByText('wsl@ubuntu.test')).toBeTruthy()
    fireEvent.click(screen.getByText('Close Settings'))
    await enter()
    await add()
    expect(fake.add.mock.lastCall?.[0].runtime).toBe('host')
    fireEvent.click(screen.getByText('Choose local host'))
    await add()
    expect(fake.add.mock.lastCall?.[0].runtime).toBe('wsl')
    fireEvent.click(screen.getByText('Close Settings'))
    await enter()
    fireEvent.click(screen.getByText('Ordinary accounts'))
    await add()
    expect(fake.add.mock.lastCall?.[0].runtime).toBe('wsl')
  }
)
