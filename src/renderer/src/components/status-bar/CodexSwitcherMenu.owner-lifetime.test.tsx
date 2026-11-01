// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import type * as ProviderAccountsClient from '@/runtime/runtime-provider-accounts-client'
import type * as CodexSessionRestart from '@/lib/codex-session-restart'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import type { CodexRateLimitAccountsState } from '../../../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { ProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { CodexSwitcherMenu } from './CodexSwitcherMenu'

const mocks = vi.hoisted(() => ({ load: vi.fn(), select: vi.fn(), reauthenticate: vi.fn() }))
vi.mock('@/runtime/runtime-provider-accounts-client', async (original) => ({
  ...(await original<typeof ProviderAccountsClient>()),
  fetchProviderAccountsSnapshot: mocks.load,
  selectCodexProviderAccount: mocks.select
}))
vi.mock('@/lib/codex-session-restart', async (original) => ({
  ...(await original<typeof CodexSessionRestart>()),
  markLiveCodexSessionsForRestart: vi.fn()
}))
vi.mock('@/lib/windows-terminal-capabilities', () => ({
  useWindowsTerminalCapabilities: () => ({ wslDistros: [], isLoading: false }),
  getWindowsTerminalCapabilityOwnerKey: () => 'local'
}))
vi.mock('./ProviderDetailsMenu', () => ({
  ProviderDetailsMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>
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
  ['list', null],
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
      expect(mocks.load).toHaveBeenCalledTimes(2)
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
