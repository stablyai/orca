// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { accountHost, accountTransport } from '@/runtime/provider-account-observation.test-fixture'
import { ClaudeSwitcherMenu } from './ClaudeSwitcherMenu'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/claude-account-switch-sessions', () => ({
  handleRunningClaudeSessionsAfterSwitch: vi.fn()
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
const initial = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.clearAllMocks()
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
function replacementOwner(id: string | null) {
  useAppStore.setState((state) => ({
    settings: { ...state.settings!, activeRuntimeEnvironmentId: id }
  }))
}
function row(id: string) {
  return screen.getByText(`${id}@example.com`).closest('[role="menuitem"]')!
}
async function expand() {
  if (screen.queryByText('b@example.com')) {
    return
  }
  fireEvent.click(screen.getAllByText('a@example.com')[0])
  await act(async () => {})
}

it.each([
  ['select', 'resolve'],
  ['select', 'reject'],
  ['sign-in', 'resolve'],
  ['sign-in', 'reject']
] as const)(
  'retires pending %s with its owner after late %s and admits a replacement action',
  async (operation, settlement) => {
    const local = accountHost(),
      a = accountHost(),
      b = accountHost()
    const transport = accountTransport({ a, b })
    const pending = deferred<typeof a.snapshot.claude>()
    const select = vi.fn(() => pending.promise)
    const reauthenticate = vi.fn(() => pending.promise)
    if (operation === 'sign-in') {
      local.snapshot.claude.accounts[1].needsSignIn = true
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        claudeAccounts: {
          ...window.api.claudeAccounts,
          list: async () => local.snapshot.claude,
          select,
          reauthenticate
        },
        codexAccounts: { ...window.api.codexAccounts, list: async () => local.snapshot.codex }
      }
    })
    mocks.rpc.mockImplementation(async (target) =>
      target.environmentId === 'a' ? pending.promise : b.snapshot.claude
    )
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/test'),
        claudeManagedAccounts: local.snapshot.claude.accounts.map((account) => ({
          ...account,
          managedAuthPath: '/unused'
        })),
        activeClaudeManagedAccountId: 'a',
        activeClaudeManagedAccountIdsByRuntime: { host: 'a', wsl: {} },
        activeRuntimeEnvironmentId: operation === 'sign-in' ? null : 'a'
      },
      fetchSettings: vi.fn(async () => {}),
      fetchInactiveClaudeAccountUsage: vi.fn(async () => {})
    })
    render(<ClaudeSwitcherMenu claude={null} compact iconOnly />)
    await act(async () => {})
    await expand()
    fireEvent.click(row('b'))
    await act(async () => {})
    expect(operation === 'sign-in' ? reauthenticate : mocks.rpc).toHaveBeenCalledTimes(1)
    expect(row('b').getAttribute('aria-disabled')).toBe('true')
    await act(async () => replacementOwner('b'))
    await expand()
    // The old answer is deliberately different from the replacement owner's authoritative roster.
    const late = {
      ...a.snapshot.claude,
      activeAccountId: 'b',
      activeAccountIdsByRuntime: { host: 'b', wsl: {} }
    }
    await act(async () => {
      if (settlement === 'resolve') {
        pending.resolve(late)
      } else {
        pending.reject(new Error('Fixture operation failed'))
      }
    })
    expect(row('b').getAttribute('aria-disabled')).toBe('false')
    fireEvent.click(row('b'))
    await act(async () => {})
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'b' },
      'accounts.selectClaude',
      { accountId: 'b' },
      { timeoutMs: 30000 }
    )
    expect(transport.streams.some((stream) => stream.host === 'b')).toBe(true)
  }
)
