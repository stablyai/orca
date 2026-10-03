// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GrokAccountsState } from '../../../../shared/grok-account-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  select: vi.fn(),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  remoteRuntime: false,
  webClient: false
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/lib/agent-catalog', () => ({ AgentIcon: () => null }))
vi.mock('@/lib/desktop-window-chrome', () => ({
  isPairedWebClientWindow: () => mocks.webClient
}))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: { activeRuntimeEnvironmentId: mocks.remoteRuntime ? 'remote' : null },
      usagePercentageDisplay: 'used',
      openSettingsPage: mocks.openSettingsPage,
      openSettingsTarget: mocks.openSettingsTarget
    })
}))
vi.mock('./ProviderDetailsMenu', () => ({
  ProviderDetailsMenu: ({
    children,
    open,
    onOpenChange
  }: {
    children: React.ReactNode
    open: boolean
    onOpenChange: (open: boolean) => void
  }) => (
    <>
      <button onClick={() => onOpenChange(!open)}>Open Grok</button>
      {open ? <div role="menu">{children}</div> : null}
    </>
  )
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    ...props
  }: React.PropsWithChildren<{
    disabled?: boolean
    onSelect?: (event: { preventDefault: () => void }) => void
  }>) => (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={() => onSelect?.({ preventDefault: () => {} })}
      {...props}
    >
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />
}))

import { GrokSwitcherMenu } from './GrokSwitcherMenu'

const grok: ProviderRateLimits = {
  provider: 'grok',
  session: null,
  weekly: { usedPercent: 16, windowMinutes: 10080, resetsAt: null, resetDescription: 'Tuesday' },
  error: null,
  status: 'ok',
  updatedAt: 1
}
const accounts: GrokAccountsState = {
  accounts: [
    { id: 'alice', email: 'alice@example.com', userId: 'alice', teamId: null },
    { id: 'bob', email: 'bob@example.com', userId: 'bob', teamId: null }
  ],
  activeAccountId: 'alice',
  usage: {
    alice: grok,
    bob: {
      ...grok,
      weekly: null,
      monthly: { usedPercent: 12, windowMinutes: 43200, resetsAt: null, resetDescription: 'Friday' }
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.remoteRuntime = false
  mocks.webClient = false
  mocks.list.mockResolvedValue(accounts)
  mocks.select.mockImplementation(async (id: string | null) => ({
    ...accounts,
    activeAccountId: id
  }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { grokAccounts: { list: mocks.list, select: mocks.select } }
  })
})
afterEach(cleanup)

async function openAccounts(): Promise<void> {
  render(<GrokSwitcherMenu grok={grok} compact={false} iconOnly={false} />)
  expect(mocks.list).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Open Grok' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'alice@example.com' }))
}

it('switches a saved account from its own usage row and keeps the picker open', async () => {
  await openAccounts()
  const alice = screen.getByRole('menuitem', { name: /alice@example.com Active/ })
  const bob = screen.getByRole('menuitem', { name: /bob@example.com/ })
  expect(alice).toBeDisabled()
  expect(within(alice).getByText('16% used wk')).toBeVisible()
  expect(within(bob).getByText('12% used Monthly')).toBeVisible()
  fireEvent.click(bob)
  await waitFor(() => expect(mocks.select).toHaveBeenCalledWith('bob'))
  await waitFor(() =>
    expect(screen.getByRole('menuitem', { name: /bob@example.com Active/ })).toBeDisabled()
  )
  expect(screen.getByRole('menu')).toBeVisible()
  expect(screen.getByText(/Existing sessions keep their own account/)).toBeVisible()
})

it('selects the system login and opens the Grok account settings section', async () => {
  await openAccounts()
  fireEvent.click(screen.getByRole('menuitem', { name: 'System default' }))
  await waitFor(() => expect(mocks.select).toHaveBeenCalledWith(null))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Manage Accounts…' }))
  expect(mocks.openSettingsTarget).toHaveBeenCalledWith({
    pane: 'accounts',
    repoId: null,
    sectionId: 'accounts-grok'
  })
  expect(mocks.openSettingsPage).toHaveBeenCalledOnce()
})

it('keeps the current selection and exposes a failed switch for retry', async () => {
  mocks.select.mockRejectedValueOnce(new Error('Account selection failed'))
  await openAccounts()
  fireEvent.click(screen.getByRole('menuitem', { name: /bob@example.com/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Account selection failed')
  expect(screen.getByRole('menuitem', { name: /alice@example.com Active/ })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: /bob@example.com/ })).toBeEnabled()
})

it('blocks overlapping switches while the first selection is pending', async () => {
  let finish: ((next: GrokAccountsState) => void) | undefined
  mocks.select.mockImplementationOnce(
    () =>
      new Promise<GrokAccountsState>((resolve) => {
        finish = resolve
      })
  )
  await openAccounts()
  fireEvent.click(screen.getByRole('menuitem', { name: /bob@example.com/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'System default' }))
  expect(mocks.select).toHaveBeenCalledOnce()
  finish?.({ ...accounts, activeAccountId: 'bob' })
  await waitFor(() =>
    expect(screen.getByRole('menuitem', { name: /bob@example.com Active/ })).toBeDisabled()
  )
})

it('shows account-loading failures without claiming a system account is selected', async () => {
  mocks.list.mockRejectedValueOnce(new Error('Unavailable'))
  render(<GrokSwitcherMenu grok={grok} compact={false} iconOnly={false} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open Grok' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load saved Grok accounts.')
  expect(screen.queryByText('System default')).toBeNull()
  expect(screen.getByRole('menuitem', { name: 'Manage Accounts…' })).toBeEnabled()
})

it.each(['remote', 'web'])(
  'does not select desktop accounts for a %s usage owner',
  async (owner) => {
    mocks.remoteRuntime = owner === 'remote'
    mocks.webClient = owner === 'web'
    render(<GrokSwitcherMenu grok={grok} compact={false} iconOnly={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open Grok' }))
    expect(screen.getByText('Manage Grok accounts on the computer running Orca.')).toBeVisible()
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.select).not.toHaveBeenCalled()
  }
)
