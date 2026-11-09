// @vitest-environment happy-dom
import type { PropsWithChildren } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { SshConnectionState, SshConnectionStatus } from '../../../../shared/ssh-types'
import type { Repo } from '../../../../shared/repo-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SshStatusSegment } from './SshStatusSegment'
import { HOST_LIST_ROW_LIMIT } from '../host-picker/bounded-host-list'
import { SSH_STATUS_MENU_IDLE_ROW_LIMIT } from './ssh-status-menu-rows'
import type * as RegistryModule from '../../../../shared/execution-host/execution-host-registry'
import type * as MenuRowsModule from './ssh-status-menu-rows'
import type * as ConnectionStatusModule from './remote-host-connection-status'
import { connectRuntimeHostAndReloadProjects } from './runtime-environment-explicit-connect'

const inventoryVisits = vi.hoisted(() => ({ registry: 0, split: 0, overall: 0 }))
vi.mock('../../../../shared/execution-host/execution-host-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof RegistryModule>()
  return {
    ...actual,
    buildExecutionHostRegistry: (...args: Parameters<typeof actual.buildExecutionHostRegistry>) => {
      inventoryVisits.registry += args[0].sshTargetLabels?.size ?? 0
      return actual.buildExecutionHostRegistry(...args)
    }
  }
})
vi.mock('./ssh-status-menu-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof MenuRowsModule>()
  return {
    ...actual,
    splitSshStatusMenuRows: (...args: Parameters<typeof actual.splitSshStatusMenuRows>) => {
      inventoryVisits.split += args[0].length
      return actual.splitSshStatusMenuRows(...args)
    }
  }
})
vi.mock('./remote-host-connection-status', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionStatusModule>()
  return {
    ...actual,
    sshStatusForOverall: (...args: Parameters<typeof actual.sshStatusForOverall>) => {
      inventoryVisits.overall += 1
      return actual.sshStatusForOverall(...args)
    }
  }
})

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
vi.mock('./runtime-environment-explicit-connect', () => ({
  connectRuntimeHostAndReloadProjects: vi.fn(async () => false)
}))
vi.mock('@/components/ui/dropdown-menu', () => {
  const content = ({ children }: PropsWithChildren) => <div>{children}</div>
  return {
    DropdownMenu: ({
      children,
      onOpenChange
    }: PropsWithChildren<{ onOpenChange?: (open: boolean) => void }>) => (
      <div>
        <button onClick={() => onOpenChange?.(true)}>Open hosts fixture</button>
        {children}
      </div>
    ),
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
  state.runtimeEnvironments = []
  state.runtimeStatusByEnvironmentId = new Map()
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
  vi.useRealTimers()
})

describe('the status menu with a very large imported SSH host list', () => {
  it.each([13_692, 136_920])(
    'does no inventory work for local recovery/clock updates with %i hosts',
    async (count) => {
      vi.useFakeTimers()
      vi.setSystemTime(10_000)
      state.sshTargetLabels = new Map(
        Array.from({ length: count }, (_, index) => [`ssh-${index}`, `node-${index}`])
      )
      state.sshConnectionStates = new Map()
      inventoryVisits.registry = inventoryVisits.split = inventoryVisits.overall = 0
      const element = (
        <TooltipProvider>
          <SshStatusSegment compact={false} iconOnly={false} />
        </TooltipProvider>
      )
      const view = render(element)
      expect(inventoryVisits).toEqual({ registry: count, split: count, overall: count })
      // One actual status input changes; its closed-menu observation adjustment must reuse that inventory.
      state.sshConnectionStates = new Map([['ssh-0', connectionState('ssh-0', 'reconnecting')]])
      view.rerender(
        <TooltipProvider>
          <SshStatusSegment compact={false} iconOnly={false} />
        </TooltipProvider>
      )
      expect(inventoryVisits).toEqual({ registry: count * 2, split: count * 2, overall: count * 2 })
      state.sshConnectionStates = new Map([
        ['ssh-0', { ...connectionState('ssh-0', 'reconnecting'), reconnectAttempt: 1 }]
      ])
      view.rerender(
        <TooltipProvider>
          <SshStatusSegment compact={false} iconOnly={false} />
        </TooltipProvider>
      )
      expect(inventoryVisits).toEqual({ registry: count * 3, split: count * 3, overall: count * 3 })
      fireEvent.click(screen.getByRole('button', { name: 'Open hosts fixture' }))
      await act(() => vi.advanceTimersByTimeAsync(30_000))
      expect(screen.getByRole('menuitem', { name: 'Retry now' })).toBeTruthy()
      expect(inventoryVisits).toEqual({ registry: count * 3, split: count * 3, overall: count * 3 })
      // A meaningful catalog change still rebuilds and renders the added host.
      state.sshTargetLabels = new Map(state.sshTargetLabels).set('live', 'New live host')
      state.sshConnectionStates = new Map(state.sshConnectionStates).set(
        'live',
        connectionState('live', 'connected')
      )
      view.rerender(
        <TooltipProvider>
          <SshStatusSegment compact={false} iconOnly={false} />
        </TooltipProvider>
      )
      expect(screen.getByText('New live host')).toBeTruthy()
      expect(inventoryVisits).toEqual({
        registry: count * 4 + 1,
        split: count * 4 + 1,
        overall: count * 4 + 1
      })
    }
  )

  it('renders a bounded number of idle host rows instead of one per imported host', () => {
    render(
      <TooltipProvider>
        <SshStatusSegment compact={false} iconOnly={false} />
      </TooltipProvider>
    )
    const connectButtons = screen.queryAllByRole('button', { name: 'Connect' })
    expect(connectButtons.length).toBeLessThanOrEqual(SSH_STATUS_MENU_IDLE_ROW_LIMIT + 1)
    expect(document.body.getElementsByTagName('*').length).toBeLessThan(2_000)
  })

  it('always lists connected and in-progress hosts, wherever they sit in the list', () => {
    render(
      <TooltipProvider>
        <SshStatusSegment compact={false} iconOnly={false} />
      </TooltipProvider>
    )
    expect(screen.getByText('node-09000')).toBeTruthy()
    expect(screen.getByText('node-13000')).toBeTruthy()
    expect(screen.getByText('node-00000')).toBeTruthy()
    expect(screen.queryByText('node-13691')).toBeNull()
  })

  it('offers a search for the hidden hosts that connects the exact host typed', async () => {
    const connect = vi.fn(async () => undefined)
    vi.stubGlobal('api', { ssh: { connect } })
    state.sshConnectionStates.set('ssh-5', connectionState('ssh-5', 'auth-failed'))
    render(
      <TooltipProvider>
        <SshStatusSegment compact={false} iconOnly={false} />
      </TooltipProvider>
    )
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

  it('keeps a pending retry visible when SSH replacement briefly publishes disconnected', async () => {
    let resolveConnect: () => void = () => undefined
    const request = new Promise<void>((resolve) => {
      resolveConnect = resolve
    })
    vi.stubGlobal('api', { ssh: { connect: vi.fn(() => request) } })
    state.sshConnectionStates.set('ssh-13000', {
      ...connectionState('ssh-13000', 'reconnecting'),
      reconnectAttempt: 2
    })
    const view = render(
      <TooltipProvider>
        <SshStatusSegment compact={false} iconOnly={false} />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retry now' }))
    state.sshConnectionStates = new Map(state.sshConnectionStates).set(
      'ssh-13000',
      connectionState('ssh-13000', 'disconnected')
    )
    view.rerender(
      <TooltipProvider>
        <SshStatusSegment compact={false} iconOnly={false} />
      </TooltipProvider>
    )
    expect(screen.getByText('node-13000')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop node-13000' })).toBeTruthy()
    resolveConnect()
    await vi.waitFor(() => expect(screen.queryByText('node-13000')).toBeNull())
    vi.unstubAllGlobals()
  })

  it('does not reuse a stopped server’s retry count on a new Connect', async () => {
    let resolveConnect: (value: boolean) => void = () => undefined
    vi.mocked(connectRuntimeHostAndReloadProjects).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConnect = resolve
        })
    )
    state.sshTargetLabels = new Map()
    state.sshConnectionStates = new Map()
    state.runtimeEnvironments = [
      {
        id: 'server',
        name: 'Server',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: null,
        runtimeId: null,
        source: 'manual',
        preferredEndpointId: 'direct',
        endpoints: [
          { id: 'direct', kind: 'websocket', label: 'Direct', endpoint: 'ws://127.0.0.1:1' }
        ]
      }
    ]
    state.runtimeStatusByEnvironmentId.set('server', {
      status: null,
      checkedAt: 0,
      remoteControl: {
        state: 'closed',
        reconnectAttempt: 7,
        pendingRequestCount: 0,
        subscriptionCount: 0,
        lastConnectedAt: null,
        lastClose: null,
        lastError: null
      }
    })
    render(
      <TooltipProvider>
        <SshStatusSegment compact={false} iconOnly={false} />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Connect Server' }))
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Stop Server' })).toBeTruthy())
    expect(screen.queryByRole('menuitem', { name: 'Retry now' })).toBeNull()
    resolveConnect(false)
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Connect Server' })).toBeTruthy()
    )
  })

  it('caps the search results and says how many more match', async () => {
    render(
      <TooltipProvider>
        <SshStatusSegment compact={false} iconOnly={false} />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /^Find among/ }))
    const search = await screen.findByRole('combobox')
    fireEvent.change(search, { target: { value: 'node-1' } })
    expect(screen.getAllByRole('option').length).toBeLessThanOrEqual(HOST_LIST_ROW_LIMIT)
    expect(screen.getByText(/more matches\. Keep typing/)).toBeTruthy()
    fireEvent.change(search, { target: { value: 'no-such-host' } })
    expect(screen.getByText('No SSH hosts match.')).toBeTruthy()
  })

  it('returns focus to the status button when the search is closed from the keyboard', async () => {
    render(
      <TooltipProvider>
        <SshStatusSegment compact={false} iconOnly={false} />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('menuitem', { name: /^Find among/ }))
    const search = await screen.findByRole('combobox')
    search.focus()
    fireEvent.keyDown(search, { key: 'Escape' })
    await vi.waitFor(() => expect(screen.queryByRole('combobox')).toBeNull())
    const trigger = screen.getByRole('button', { name: 'Remote host connection status' })
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})
