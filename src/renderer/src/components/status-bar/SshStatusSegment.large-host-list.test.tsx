// @vitest-environment happy-dom
import type { PropsWithChildren } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import type { SshConnectionState, SshConnectionStatus } from '../../../../shared/ssh-types'
import type { Repo } from '../../../../shared/repo-types'
import { SshStatusSegment } from './SshStatusSegment'
import { HOST_LIST_ROW_LIMIT } from '../host-picker/bounded-host-list'
import { SSH_STATUS_MENU_IDLE_ROW_LIMIT } from './ssh-status-menu-rows'

function noSettings(): GlobalSettings | null {
  return null
}

const state = {
  sshTargetLabels: new Map<string, string>(),
  sshConnectionStates: new Map<string, SshConnectionState>(),
  repos: new Array<Pick<Repo, 'id' | 'connectionId'>>(),
  runtimeEnvironments: new Array<PublicKnownRuntimeEnvironment>(),
  runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>(),
  settings: noSettings(),
  readRuntimeHostStatusSnapshots: vi.fn(async () => undefined),
  hydrateRuntimeEnvironmentStatuses: vi.fn(),
  recordFeatureInteraction: vi.fn(),
  openSettingsTarget: vi.fn(),
  setActiveView: vi.fn()
}

vi.mock('../../store', () => {
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('../../lib/ssh-config-passive-sync', () => ({
  syncSshConfigTargetsPassively: vi.fn(async () => undefined)
}))
vi.mock('@/components/ui/dropdown-menu', () => {
  const content = ({ children }: PropsWithChildren) => <div>{children}</div>
  return {
    DropdownMenu: content,
    DropdownMenuContent: content,
    DropdownMenuItem: ({ children, onSelect }: PropsWithChildren<{ onSelect?: () => void }>) => (
      <div role="menuitem" onClick={onSelect}>
        {children}
      </div>
    ),
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuTrigger: content,
    DropdownMenuSub: content,
    DropdownMenuSubContent: content,
    DropdownMenuSubTrigger: content
  }
})

// Why 13,692: the host count from the generated ~/.ssh/config in the crash this guards.
const IMPORTED_HOST_COUNT = 13_692

function connectionState(targetId: string, status: SshConnectionStatus): SshConnectionState {
  return { targetId, status, error: null, reconnectAttempt: 0 }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.sshTargetLabels = new Map(
    Array.from({ length: IMPORTED_HOST_COUNT }, (_, index) => [
      `ssh-${index}`,
      `node-${String(index).padStart(5, '0')}`
    ])
  )
  state.sshConnectionStates = new Map([
    ['ssh-9000', connectionState('ssh-9000', 'connected')],
    ['ssh-13000', connectionState('ssh-13000', 'reconnecting')]
  ])
  state.repos = [{ id: 'repo-1', connectionId: 'ssh-12345' }]
})

afterEach(() => {
  cleanup()
})

describe('the status menu with a very large imported SSH host list', () => {
  it('renders a bounded number of idle host rows instead of one per imported host', () => {
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    const connectButtons = screen.queryAllByRole('button', { name: 'Connect' })
    expect(connectButtons.length).toBeLessThanOrEqual(SSH_STATUS_MENU_IDLE_ROW_LIMIT + 1)
    expect(document.body.getElementsByTagName('*').length).toBeLessThan(2_000)
  })

  it('always lists connected and in-progress hosts, wherever they sit in the list', () => {
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getByText('node-09000')).toBeTruthy()
    expect(screen.getByText('node-13000')).toBeTruthy()
    expect(screen.getByText('node-00000')).toBeTruthy()
    expect(screen.queryByText('node-13691')).toBeNull()
  })

  it('keeps an idle host that owns a project, even deep in the config', () => {
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    expect(screen.getByText('node-12345')).toBeTruthy()
  })

  it('offers a search for the hidden hosts that connects the exact host typed', async () => {
    const connect = vi.fn(async () => undefined)
    vi.stubGlobal('api', { ssh: { connect } })
    state.sshConnectionStates.set('ssh-5', connectionState('ssh-5', 'auth-failed'))
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    const hidden = IMPORTED_HOST_COUNT - 3 - SSH_STATUS_MENU_IDLE_ROW_LIMIT
    fireEvent.click(screen.getByRole('menuitem', { name: `Find among ${hidden} more SSH hosts…` }))
    const search = await screen.findByRole('combobox')
    fireEvent.change(search, { target: { value: 'node-13691' } })
    expect(screen.getByRole('option', { name: /node-13691/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /node-00005/ })).toBeNull()
    fireEvent.keyDown(search, { key: 'Enter' })
    await vi.waitFor(() => expect(connect).toHaveBeenCalledWith({ targetId: 'ssh-13691' }))
    expect(connect).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('caps the search results and says how many more match', async () => {
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Find among/ }))
    const search = await screen.findByRole('combobox')
    fireEvent.change(search, { target: { value: 'node-1' } })
    expect(screen.getAllByRole('option').length).toBeLessThanOrEqual(HOST_LIST_ROW_LIMIT)
    expect(screen.getByText(/more matches\. Keep typing/)).toBeTruthy()
    fireEvent.change(search, { target: { value: 'no-such-host' } })
    expect(screen.getByText('No SSH hosts match.')).toBeTruthy()
  })

  it('returns focus to the status button when the search is closed from the keyboard', async () => {
    render(<SshStatusSegment compact={false} iconOnly={false} />)
    fireEvent.click(screen.getByRole('menuitem', { name: /^Find among/ }))
    const search = await screen.findByRole('combobox')
    search.focus()
    fireEvent.keyDown(search, { key: 'Escape' })
    await vi.waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
    const trigger = screen.getByRole('button', { name: 'Remote host connection status' })
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
