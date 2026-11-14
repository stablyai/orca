// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type * as ProviderAccountsClient from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import type * as CodexSessionRestart from '@/lib/agent-session/accounts/codex/codex-session-restart'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import type { CodexRateLimitAccountsState } from '../../../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import { toast } from 'sonner'
import { markLiveCodexSessionsForRestart } from '@/lib/agent-session/accounts/codex/codex-session-restart'
import { CodexSwitcherMenu } from './CodexSwitcherMenu'

const mocks = vi.hoisted(() => ({ load: vi.fn(), select: vi.fn(), reauthenticate: vi.fn() }))
vi.mock(
  '@/runtime/provider-accounts/observations/runtime-provider-accounts-client',
  async (original) => ({
    ...(await original<typeof ProviderAccountsClient>()),
    fetchProviderAccountsSnapshot: mocks.load,
    selectCodexProviderAccount: mocks.select
  })
)
vi.mock('@/lib/agent-session/accounts/codex/codex-session-restart', async (original) => ({
  ...(await original<typeof CodexSessionRestart>()),
  markLiveCodexSessionsForRestart: vi.fn()
}))
vi.mock('@/runtime/hosts/capabilities/windows-terminal-capabilities', () => ({
  useWindowsTerminalCapabilities: () => ({ wslDistros: [], isLoading: false }),
  getWindowsTerminalCapabilityOwnerKey: () => 'local'
}))
vi.mock('./ProviderDetailsMenu', () => ({
  ProviderDetailsMenu: ({
    children,
    open,
    onOpenChange
  }: {
    children: ReactNode
    open: boolean
    onOpenChange: (open: boolean) => void
  }) => (
    <div>
      <button aria-expanded={open} onClick={() => onOpenChange(!open)}>
        Toggle details
      </button>
      {children}
    </div>
  )
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect: (event: { preventDefault: () => void }) => void
  }) => (
    <div
      role="menuitem"
      aria-disabled={!!disabled}
      onClick={() => {
        if (!disabled) {
          onSelect({ preventDefault: () => {} })
        }
      }}
    >
      {children}
    </div>
  )
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const initial = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function accounts(owner: string): CodexRateLimitAccountsState {
  return {
    accounts: [owner, `${owner}-other`].map((id) => ({
      id,
      email: `${id}@example.com`,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    })),
    activeAccountId: owner
  }
}

function snapshot(owner: string): ProviderAccountsSnapshot {
  return {
    codex: accounts(owner),
    claude: { accounts: [], activeAccountId: null },
    rateLimits: null
  }
}

it.each(['before', 'after'] as const)(
  'refreshes a returned owner when its old roster resolves %s its retired selection',
  async (order) => {
    const pending = deferred<CodexRateLimitAccountsState>()
    const returnedRoster = deferred<ProviderAccountsSnapshot>()
    const selected = { ...accounts('remote-a'), activeAccountId: 'remote-a-other' }
    mocks.load
      .mockResolvedValueOnce(snapshot('remote-a'))
      .mockResolvedValueOnce(snapshot('remote-b'))
      .mockReturnValueOnce(returnedRoster.promise)
      .mockResolvedValueOnce({ ...snapshot('remote-a'), codex: selected })
    mocks.select.mockReturnValueOnce(pending.promise)
    configureOwner('remote-a')
    render(<CodexSwitcherMenu codex={usage} compact iconOnly />)
    await act(async () => {})
    await expand('remote-a')
    fireEvent.click(row('remote-a'))
    await act(async () =>
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'remote-b' }
      }))
    )
    await act(async () =>
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'remote-a' }
      }))
    )
    if (order === 'before') {
      await act(async () => returnedRoster.resolve(snapshot('remote-a')))
      await expand('remote-a')
      expect(row('remote-a').getAttribute('aria-disabled')).toBe('false')
    }
    await act(async () => pending.resolve(selected))
    if (order === 'after') {
      await act(async () => returnedRoster.resolve(snapshot('remote-a')))
      await expand('remote-a')
    }
    expect(row('remote-a').getAttribute('aria-disabled')).toBe('true')
    const previousAccountRow = screen
      .getByText('remote-a@example.com')
      .closest('[role="menuitem"]')!
    expect(previousAccountRow.getAttribute('aria-disabled')).toBe('false')
    mocks.select.mockResolvedValueOnce(accounts('remote-a'))
    fireEvent.click(previousAccountRow)
    await act(async () => {})
    expect(mocks.select).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'remote-a' },
      { accountId: 'remote-a', runtime: 'host', wslDistro: null }
    )
    expect(previousAccountRow.getAttribute('aria-disabled')).toBe('true')
    expect(row('remote-a').getAttribute('aria-disabled')).toBe('false')
  }
)

const usage: ProviderRateLimits = {
  provider: 'codex',
  session: null,
  weekly: null,
  status: 'ok',
  error: null,
  updatedAt: 1
}

function configureOwner(environmentId: string | null) {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/test'),
      activeRuntimeEnvironmentId: environmentId,
      codexManagedAccounts: accounts('local').accounts.map((account) => ({
        ...account,
        managedHomePath: '/unused'
      })),
      activeCodexManagedAccountId: 'local'
    },
    fetchSettings: vi.fn(async () => {}),
    fetchInactiveCodexAccountUsage: vi.fn(async () => {})
  })
}

function row(owner: string) {
  return screen.getByText(`${owner}-other@example.com`).closest('[role="menuitem"]')!
}

async function expand(owner: string) {
  if (screen.queryByText(`${owner}-other@example.com`)) {
    return
  }
  fireEvent.click(screen.getAllByText(`${owner}@example.com`)[0])
  await act(async () => {})
}

it.each([
  ['select', null],
  ['list', 'remote-b'],
  ['select', 'remote-b']
] as const)(
  'retires the old roster and pending %s when moving to %s',
  async (operation, nextEnvironmentId) => {
    const pending = deferred<ProviderAccountsSnapshot>()
    const replacement = deferred<ProviderAccountsSnapshot>()
    mocks.load.mockResolvedValueOnce(snapshot('remote-a'))
    configureOwner('remote-a')
    render(<CodexSwitcherMenu codex={usage} compact iconOnly />)
    await act(async () => {})
    await expand('remote-a')
    if (operation === 'list') {
      mocks.load.mockReturnValueOnce(pending.promise)
      await act(async () =>
        useAppStore.setState((state) => ({
          settings: {
            ...state.settings!,
            codexManagedAccounts: state.settings!.codexManagedAccounts.map((account) => ({
              ...account,
              updatedAt: 2
            }))
          }
        }))
      )
    } else {
      mocks.select.mockImplementationOnce(async () => (await pending.promise).codex)
      fireEvent.click(row('remote-a'))
      expect(row('remote-a').getAttribute('aria-disabled')).toBe('true')
    }
    mocks.load.mockReturnValueOnce(replacement.promise)
    await act(async () =>
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: nextEnvironmentId }
      }))
    )
    expect(screen.queryAllByText('remote-a@example.com')).toHaveLength(0)
    const nextOwner = nextEnvironmentId ?? 'local'
    await act(async () => replacement.resolve(snapshot(nextOwner)))
    await expand(nextOwner)
    expect(row(nextOwner).getAttribute('aria-disabled')).toBe('false')
    await act(async () => pending.resolve(snapshot('stale-owner')))
    expect(screen.queryByText('stale-owner@example.com')).toBeNull()
    expect(row(nextOwner).getAttribute('aria-disabled')).toBe('false')
    if (operation === 'select') {
      expect(markLiveCodexSessionsForRestart).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: { kind: 'environment', environmentId: 'remote-a' },
          target: { runtime: 'host', wslDistro: null }
        })
      )
    }
    mocks.select.mockResolvedValueOnce(accounts(nextOwner))
    fireEvent.click(row(nextOwner))
    await act(async () => {})
    expect(mocks.select).toHaveBeenLastCalledWith(
      nextEnvironmentId === null
        ? { kind: 'local' }
        : { kind: 'environment', environmentId: nextEnvironmentId },
      { accountId: `${nextOwner}-other`, runtime: 'host', wslDistro: null }
    )
  }
)

it.each(['resolve', 'reject'] as const)(
  'retires local sign-in busy state across an owner change and late %s',
  async (settlement) => {
    const pending = deferred<CodexRateLimitAccountsState>()
    mocks.load.mockResolvedValueOnce(snapshot('local')).mockResolvedValueOnce(snapshot('remote-b'))
    mocks.reauthenticate.mockReturnValueOnce(pending.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        codexAccounts: { ...window.api?.codexAccounts, reauthenticate: mocks.reauthenticate }
      }
    })
    configureOwner(null)
    useAppStore.setState((state) => ({
      rateLimits: {
        ...state.rateLimits,
        inactiveCodexAccounts: [
          {
            accountId: 'local-other',
            updatedAt: 1,
            isFetching: false,
            rateLimits: { ...usage, status: 'error', error: 'Not signed in' }
          }
        ]
      }
    }))
    render(<CodexSwitcherMenu codex={usage} compact iconOnly />)
    await act(async () => {})
    await expand('local')
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }))
    expect(row('local').getAttribute('aria-disabled')).toBe('true')
    await act(async () =>
      useAppStore.setState((state) => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'remote-b' }
      }))
    )
    await expand('remote-b')
    expect(row('remote-b').getAttribute('aria-disabled')).toBe('false')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      if (settlement === 'resolve') {
        pending.resolve(accounts('stale-owner'))
      } else {
        pending.reject(new Error('Fixture sign-in failed'))
      }
    })
    expect(screen.queryByText('stale-owner@example.com')).toBeNull()
    expect(row('remote-b').getAttribute('aria-disabled')).toBe('false')
    if (settlement === 'resolve') {
      expect(toast.success).toHaveBeenCalled()
      expect(toast.error).not.toHaveBeenCalled()
    } else {
      // A sign-in that fails after the user moved to another host is still reported.
      expect(toast.error).toHaveBeenCalled()
      expect(toast.success).not.toHaveBeenCalled()
    }
    if (settlement === 'resolve') {
      expect(markLiveCodexSessionsForRestart).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: { kind: 'local' },
          target: { runtime: 'host', wslDistro: null }
        })
      )
    }
    mocks.select.mockResolvedValueOnce(accounts('remote-b'))
    fireEvent.click(row('remote-b'))
    await act(async () => {})
    expect(mocks.select).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'remote-b' },
      { accountId: 'remote-b-other', runtime: 'host', wslDistro: null }
    )
    errorSpy.mockRestore()
  }
)

it('keeps a completed selection when an older same-owner list resolves later', async () => {
  const pending = deferred<ProviderAccountsSnapshot>()
  mocks.load.mockResolvedValueOnce(snapshot('remote-a')).mockReturnValueOnce(pending.promise)
  configureOwner('remote-a')
  render(<CodexSwitcherMenu codex={usage} compact iconOnly />)
  await act(async () => {})
  await act(async () =>
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, activeCodexManagedAccountId: 'local-other' }
    }))
  )
  mocks.select.mockResolvedValueOnce({ ...accounts('remote-a'), activeAccountId: 'remote-a-other' })
  fireEvent.click(row('remote-a'))
  await act(async () => {})
  expect(row('remote-a').getAttribute('aria-disabled')).toBe('true')
  await act(async () => pending.resolve(snapshot('remote-a')))
  expect(row('remote-a').getAttribute('aria-disabled')).toBe('true')
  expect(
    screen
      .getByText('remote-a@example.com')
      .closest('[role="menuitem"]')
      ?.getAttribute('aria-disabled')
  ).toBe('false')
})

it('retires busy state when moving between WSL distros with the same local account target', async () => {
  const pending = deferred<CodexRateLimitAccountsState>()
  const wslAccounts: CodexRateLimitAccountsState = {
    accounts: ['Ubuntu', 'Debian'].flatMap((distro) =>
      accounts(distro).accounts.map((account) => ({
        ...account,
        managedHomeRuntime: 'wsl' as const,
        wslDistro: distro
      }))
    ),
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'Ubuntu', Debian: 'Debian' } }
  }
  mocks.load.mockResolvedValue({ ...snapshot('local'), codex: wslAccounts })
  mocks.select.mockReturnValueOnce(pending.promise)
  configureOwner('wsl-ubuntu')
  useAppStore.setState((state) => ({
    settings: {
      ...state.settings!,
      codexManagedAccounts: wslAccounts.accounts.map((account) => ({
        ...account,
        managedHomePath: '/unused'
      })),
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: wslAccounts.activeAccountIdsByRuntime
    },
    rateLimits: { ...state.rateLimits, codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' } },
    runtimeEnvironments: ['Ubuntu', 'Debian'].map((distro) => ({
      id: `wsl-${distro.toLowerCase()}`,
      name: distro,
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [
        { id: 'local', kind: 'websocket', label: 'Local bridge', endpoint: 'ws://127.0.0.1:7001' }
      ],
      preferredEndpointId: 'local',
      orcadDeployment: { kind: 'wsl', distro, localPort: 7001, remotePort: 6768 }
    }))
  }))
  render(<CodexSwitcherMenu codex={usage} compact iconOnly />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Toggle details' }))
  fireEvent.click(row('Ubuntu'))
  expect(row('Ubuntu').getAttribute('aria-disabled')).toBe('true')
  await act(async () =>
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, activeRuntimeEnvironmentId: 'wsl-debian' },
      rateLimits: { ...state.rateLimits, codexTarget: { runtime: 'wsl', wslDistro: 'Debian' } }
    }))
  )
  expect(screen.getByRole('button', { name: 'Toggle details' }).getAttribute('aria-expanded')).toBe(
    'false'
  )
  expect(row('Debian').getAttribute('aria-disabled')).toBe('false')
  await act(async () => pending.resolve(wslAccounts))
  expect(row('Debian').getAttribute('aria-disabled')).toBe('false')
  mocks.select.mockResolvedValueOnce(wslAccounts)
  fireEvent.click(row('Debian'))
  await act(async () => {})
  expect(mocks.select).toHaveBeenNthCalledWith(
    1,
    { kind: 'local' },
    { accountId: 'Ubuntu-other', runtime: 'wsl', wslDistro: 'Ubuntu' }
  )
  expect(mocks.select).toHaveBeenNthCalledWith(
    2,
    { kind: 'local' },
    { accountId: 'Debian-other', runtime: 'wsl', wslDistro: 'Debian' }
  )
})

// One remote host, "r", whose roster names which account the host reports as active.
function roster(activeAccountId: string): CodexRateLimitAccountsState {
  return {
    accounts: ['r', 'r-a', 'r-b'].map((id) => ({
      id,
      email: `${id}@example.com`,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    })),
    activeAccountId
  }
}
const hostReports = (active: string): ProviderAccountsSnapshot => ({
  ...snapshot('unused'),
  codex: roster(active)
})
const item = (id: string) => screen.getByText(`${id}@example.com`).closest('[role="menuitem"]')!
const isActive = (id: string) => item(id).getAttribute('aria-disabled') === 'true'
async function show() {
  if (!screen.queryByText('r-a@example.com')) {
    fireEvent.click(screen.getAllByText('r@example.com')[0])
    await act(async () => {})
  }
}
const focusHost = (environmentId: string) =>
  act(async () =>
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, activeRuntimeEnvironmentId: environmentId }
    }))
  )
async function reopenMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Toggle details' }))
  await act(async () => {})
}

// The remote host's own state: reads return whatever it reports at the time they are made.
function serveHost() {
  const host = { active: 'r', reachable: true }
  mocks.load.mockImplementation(async (target: { kind: string; environmentId?: string }) => {
    if (target.environmentId === 'remote-b') {
      return snapshot('remote-b')
    }
    if (!host.reachable) {
      throw new Error('host unreachable')
    }
    return hostReports(host.active)
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  return host
}

it('shows a late-applied selection on reopen even after an older selection succeeded', async () => {
  const host = serveHost()
  const older = deferred<CodexRateLimitAccountsState>()
  const newer = deferred<CodexRateLimitAccountsState>()
  mocks.select.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
  configureOwner('ordering-host')
  render(<CodexSwitcherMenu codex={usage} compact iconOnly />)
  await act(async () => {})
  await show()
  fireEvent.click(item('r-a'))
  await focusHost('remote-b')
  await focusHost('ordering-host')
  await show()
  fireEvent.click(item('r-b'))
  await act(async () => newer.reject(new Error('timed out')))
  host.active = 'r-a'
  await act(async () => older.resolve(roster('r-a')))
  await show()
  expect(isActive('r-a')).toBe(true)
  // The newer selection applies on the host only now; the older success must not have settled it.
  host.active = 'r-b'
  await reopenMenu()
  await show()
  expect(isActive('r-b')).toBe(true)
  expect(mocks.select).toHaveBeenCalledTimes(2)
})

it('keeps the list after a rejected selection whose re-read fails, then shows the host account on reopen', async () => {
  const host = serveHost()
  const selection = deferred<CodexRateLimitAccountsState>()
  const reread = deferred<ProviderAccountsSnapshot>()
  mocks.select.mockReturnValueOnce(selection.promise)
  configureOwner('rejecting-host')
  render(<CodexSwitcherMenu codex={usage} compact iconOnly />)
  await act(async () => {})
  await show()
  fireEvent.click(item('r-a'))
  await focusHost('remote-b')
  await focusHost('rejecting-host')
  host.reachable = false
  await act(async () => selection.reject(new Error('timed out')))
  await show()
  expect(isActive('r')).toBe(true)

  mocks.load.mockReturnValueOnce(reread.promise)
  await reopenMenu()
  // The previous list stays on screen while the re-read runs.
  expect(isActive('r')).toBe(true)
  expect(isActive('r-a')).toBe(false)
  await act(async () => reread.resolve(hostReports('r-a')))
  expect(isActive('r-a')).toBe(true)
  expect(mocks.select).toHaveBeenCalledTimes(1)
})

it.each(['reachable', 'unreachable'] as const)(
  'shows a late-applied selection at the first open of a menu shown again while the host was %s',
  async (whileAway) => {
    // Uncertainty outlives a test, so each case uses its own host.
    const hostId = `returning-host-${whileAway}`
    const host = serveHost()
    mocks.select.mockRejectedValueOnce(new Error('timed out'))
    configureOwner(hostId)
    render(<CodexSwitcherMenu codex={usage} compact iconOnly />)
    await act(async () => {})
    await show()
    fireEvent.click(item('r-a'))
    await act(async () => {})
    await focusHost('remote-b')
    host.reachable = whileAway === 'reachable'
    await focusHost(hostId)
    // The selection applies on the host only now, well after the menu was shown again.
    host.reachable = true
    host.active = 'r-a'
    await reopenMenu()
    await show()
    expect(isActive('r-a')).toBe(true)
    expect(mocks.select).toHaveBeenCalledTimes(1)
  }
)

it.each(['answers', 'fails', 'is overtaken by a new selection'] as const)(
  'keeps the last known list on screen at an uncertain host menu open whose read %s',
  async (read) => {
    const hostId = `last-known-host-${read.split(' ')[0]}`
    const host = serveHost()
    mocks.select.mockRejectedValueOnce(new Error('timed out'))
    configureOwner(hostId)
    render(<CodexSwitcherMenu codex={usage} compact iconOnly />)
    await act(async () => {})
    await show()
    fireEvent.click(item('r-a'))
    await act(async () => {})
    await focusHost('remote-b')
    // The rejected selection applies on the host while the user is away, so only a read can show it.
    host.active = 'r-a'
    await focusHost(hostId)
    const openRead = deferred<ProviderAccountsSnapshot>()
    mocks.load.mockReturnValueOnce(openRead.promise)
    await reopenMenu()
    await show()
    expect(isActive('r')).toBe(true)

    if (read === 'answers') {
      await act(async () => openRead.resolve(hostReports('r-a')))
      expect(isActive('r-a')).toBe(true)
      expect(mocks.select).toHaveBeenCalledTimes(1)
    } else if (read === 'fails') {
      await act(async () => openRead.reject(new Error('host unreachable')))
      expect(isActive('r')).toBe(true)
      expect(mocks.select).toHaveBeenCalledTimes(1)
    } else {
      mocks.select.mockResolvedValueOnce(roster('r-b'))
      fireEvent.click(item('r-b'))
      await act(async () => {})
      expect(isActive('r-b')).toBe(true)
      // The open read was issued before that selection, so its answer must not replace the result.
      await act(async () => openRead.resolve(hostReports('r-a')))
      expect(isActive('r-b')).toBe(true)
      expect(mocks.select).toHaveBeenCalledTimes(2)
    }
  }
)

it('prepares fresh uncertain accounts at Usage open, then refreshes a later submenu expansion', async () => {
  const host = serveHost()
  mocks.select.mockRejectedValueOnce(new Error('timed out'))
  configureOwner('parent-open-host')
  const menu = render(<CodexSwitcherMenu codex={usage} compact iconOnly />)
  await act(async () => {})
  await show()
  fireEvent.click(item('r-a'))
  await act(async () => {})
  menu.unmount()

  // Usage opens after the rejected selection finally applies on the host.
  host.active = 'r-a'
  const fresh = deferred<ProviderAccountsSnapshot>()
  mocks.load.mockReturnValueOnce(fresh.promise)
  render(<CodexSwitcherMenu codex={usage} compact iconOnly parentMenuOpen />)
  await act(async () => fresh.resolve(hostReports('r-a')))
  expect(isActive('r-a')).toBe(true)

  // Expanding Codex consumes that prepared answer rather than replacing it with another read.
  host.active = 'r-b'
  await reopenMenu()
  expect(isActive('r-a')).toBe(true)
  await reopenMenu()
  await reopenMenu()
  expect(isActive('r-b')).toBe(true)
  expect(mocks.select).toHaveBeenCalledTimes(1)
})
