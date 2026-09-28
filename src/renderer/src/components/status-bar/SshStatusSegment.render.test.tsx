// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SshStatusSegment } from './SshStatusSegment'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime-shared-control-types'

type TestState = {
  settings: { activeRuntimeEnvironmentId: string | null } | null
  sshConnectionStates: Map<string, never>
  sshTargetLabels: Map<string, string>
  runtimeStatusByEnvironmentId: Map<
    string,
    {
      status: { graphStatus: 'ready' } | null
      remoteControl?: RemoteRuntimeSharedConnectionDiagnostics
    }
  >
  remoteWorkspaceSyncStatusByTargetId: Record<string, never>
  readRuntimeHostStatusSnapshots: () => Promise<void>
  hydrateRuntimeEnvironmentStatuses: () => Promise<void>
  fetchRuntimeEnvironmentRepos: () => Promise<{ id: string }[]>
  fetchWorktrees: () => Promise<void>
  fetchWorktreeLineage: () => Promise<void>
  setActiveView: () => void
  openSettingsTarget: () => void
  recordFeatureInteraction: () => void
  runtimeEnvironments: { id: string; name: string; source?: 'manual' | 'ephemeral-vm' }[]
  setActiveRuntimeEnvironmentPreference: (id: string | null) => Promise<boolean>
  setVisibleWorkspaceHostIds: (ids: string[]) => void
}

const { switchServer, setVisibleHosts, connectHost, pairedWebClient } = vi.hoisted(() => ({
  switchServer: vi.fn<(id: string | null) => Promise<boolean>>(),
  setVisibleHosts: vi.fn<(ids: string[]) => void>(),
  connectHost: vi.fn<(id: string, timeoutMs: number) => Promise<boolean>>(),
  pairedWebClient: { value: false }
}))

const store = createStore<TestState>(() => ({
  settings: null,
  sshConnectionStates: new Map<string, never>(),
  sshTargetLabels: new Map(),
  runtimeStatusByEnvironmentId: new Map(),
  remoteWorkspaceSyncStatusByTargetId: {},
  readRuntimeHostStatusSnapshots: vi.fn(async () => {}),
  hydrateRuntimeEnvironmentStatuses: vi.fn(async () => {}),
  fetchRuntimeEnvironmentRepos: vi.fn(async () => []),
  fetchWorktrees: vi.fn(async () => {}),
  fetchWorktreeLineage: vi.fn(async () => {}),
  setActiveView: vi.fn(),
  openSettingsTarget: vi.fn(),
  recordFeatureInteraction: vi.fn(),
  runtimeEnvironments: [],
  setActiveRuntimeEnvironmentPreference: switchServer,
  setVisibleWorkspaceHostIds: setVisibleHosts
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: TestState) => unknown) => useStore(store, selector),
    { getState: () => store.getState() }
  )
}))

vi.mock('@/lib/desktop-window-chrome', () => ({
  isPairedWebClientWindow: () => pairedWebClient.value
}))

vi.mock('./runtime-environment-explicit-connect', () => ({
  connectRuntimeEnvironmentAndRecordStatus: connectHost
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  getIntlLocale: () => 'en-US'
}))

function renderSegment(iconOnly = false): void {
  render(
    <TooltipProvider>
      <SshStatusSegment compact={false} iconOnly={iconOnly} />
    </TooltipProvider>
  )
}

async function openMenu(): Promise<void> {
  fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowDown' })
  await screen.findByRole('menu')
}

beforeEach(() => {
  pairedWebClient.value = false
  switchServer.mockReset()
  setVisibleHosts.mockReset()
  connectHost.mockReset()
  connectHost.mockImplementation(async (id) => {
    store.setState({
      runtimeStatusByEnvironmentId: new Map([
        ...store.getState().runtimeStatusByEnvironmentId,
        [id, { status: { graphStatus: 'ready' } }]
      ])
    })
    return true
  })
  switchServer.mockImplementation(async (id) => {
    store.setState({ settings: { activeRuntimeEnvironmentId: id } })
    return true
  })
  store.setState({
    runtimeStatusByEnvironmentId: new Map([
      ['work', { status: { graphStatus: 'ready' } }],
      ['priv', { status: { graphStatus: 'ready' } }]
    ]),
    settings: { activeRuntimeEnvironmentId: 'work' },
    runtimeEnvironments: [
      { id: 'priv', name: 'Private server' },
      { id: 'work', name: 'Work server' },
      { id: 'temporary', name: 'Temporary VM', source: 'ephemeral-vm' }
    ]
  })
})

afterEach(cleanup)

describe('SshStatusSegment active server selection', () => {
  it('shows the active server and marks it in the real dropdown', async () => {
    renderSegment()

    expect(screen.getByRole('button').textContent).toContain('Work server')
    await openMenu()

    expect(
      screen.getByRole('menuitemradio', { name: 'Work server' }).getAttribute('aria-checked')
    ).toBe('true')
    expect(screen.getByRole('menuitemradio', { name: 'Local desktop' })).toBeDefined()
    expect(screen.queryByRole('menuitemradio', { name: 'Temporary VM' })).toBeNull()
  })

  it('switches between paired servers using the existing preference action', async () => {
    renderSegment()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Private server' }))

    await waitFor(() => {
      expect(switchServer).toHaveBeenCalledExactlyOnceWith('priv')
      expect(setVisibleHosts).toHaveBeenCalledExactlyOnceWith(['runtime:priv'])
      expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
        'Remote Hosts: Private server'
      )
    })
  })

  it('can return to the local desktop', async () => {
    renderSegment()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Local desktop' }))

    await waitFor(() => {
      expect(switchServer).toHaveBeenCalledExactlyOnceWith(null)
      expect(setVisibleHosts).toHaveBeenCalledExactlyOnceWith(['local'])
      expect(screen.getByRole('button').textContent).toContain('Local desktop')
    })
  })

  it('does not switch when selecting the current server', async () => {
    renderSegment()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Work server' }))

    expect(switchServer).not.toHaveBeenCalled()
    expect(setVisibleHosts).not.toHaveBeenCalled()
  })

  it('keeps the old label until a slow switch finishes and prevents another request', async () => {
    let finishSwitch: ((value: boolean) => void) | undefined
    switchServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSwitch = resolve
        })
    )
    renderSegment()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Private server' }))

    const trigger = screen.getByRole('button')
    expect(trigger.hasAttribute('disabled')).toBe(true)
    expect(trigger.getAttribute('aria-busy')).toBe('true')
    expect(trigger.textContent).toContain('Work server')
    expect(setVisibleHosts).not.toHaveBeenCalled()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(switchServer).toHaveBeenCalledTimes(1)

    await act(async () => {
      finishSwitch?.(true)
    })
    expect(trigger.hasAttribute('disabled')).toBe(false)
  })

  it('keeps the current server and allows retry after a failed switch', async () => {
    switchServer.mockResolvedValue(false)
    renderSegment()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Private server' }))

    await waitFor(() => expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false))
    expect(screen.getByRole('button').textContent).toContain('Work server')
    expect(setVisibleHosts).not.toHaveBeenCalled()
    await openMenu()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Private server' }))
    await waitFor(() => expect(switchServer).toHaveBeenCalledTimes(2))
  })

  it('retains an accessible active-server name in icon-only mode', async () => {
    renderSegment(true)
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Remote Hosts: Work server')
    expect(screen.getByRole('button').textContent).toBe('')
    await openMenu()
    expect(screen.getByRole('menuitemradio', { name: 'Private server' })).toBeDefined()
  })

  it('uses existing host status and offers connection actions in the row submenu', async () => {
    store.setState({ runtimeStatusByEnvironmentId: new Map([['work', { status: null }]]) })
    renderSegment()
    await openMenu()
    const work = screen.getByRole('menuitemradio', { name: 'Work server' })
    expect(work.textContent).toContain('Disconnected')
    const privateHost = screen.getByRole('menuitemradio', { name: 'Private server' })
    expect(privateHost.textContent).toContain('Checking')
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Work server: Remote Server' }), {
      key: 'ArrowRight'
    })
    await waitFor(() =>
      expect(screen.getAllByRole('menuitem', { name: 'Connect' }).length).toBeGreaterThan(1)
    )
    expect(switchServer).not.toHaveBeenCalled()
  })

  it('updates connection health independently of the selected context', async () => {
    store.setState({
      runtimeStatusByEnvironmentId: new Map([
        ['work', { status: null }],
        ['priv', { status: { graphStatus: 'ready' } }]
      ])
    })
    renderSegment()
    await openMenu()
    const work = screen.getByRole('menuitemradio', { name: 'Work server' })
    const privateHost = screen.getByRole('menuitemradio', { name: 'Private server' })
    expect(work.textContent).toContain('Disconnected')
    expect(work.getAttribute('aria-checked')).toBe('true')
    expect(privateHost.textContent).toContain('Connected')
    expect(privateHost.getAttribute('aria-checked')).toBe('false')
    act(() =>
      store.setState({
        runtimeStatusByEnvironmentId: new Map([
          ['work', { status: { graphStatus: 'ready' } }],
          ['priv', { status: null }]
        ])
      })
    )
    await waitFor(() => {
      expect(work.textContent).toContain('Connected')
      expect(privateHost.textContent).toContain('Disconnected')
    })
    expect(switchServer).not.toHaveBeenCalled()
  })

  it('connects a disconnected host before allowing context selection', async () => {
    store.setState({ runtimeStatusByEnvironmentId: new Map([['priv', { status: null }]]) })
    renderSegment()
    await openMenu()
    const privateHost = screen.getByRole('menuitemradio', { name: 'Private server' })
    expect(privateHost.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(privateHost)
    expect(switchServer).not.toHaveBeenCalled()
    const row = within(privateHost.parentElement ?? privateHost)
    fireEvent.click(row.getByRole('menuitem', { name: 'Connect' }))
    await waitFor(() => {
      expect(connectHost).toHaveBeenCalledExactlyOnceWith('priv', 5000)
      expect(privateHost.getAttribute('aria-disabled')).not.toBe('true')
    })
    expect(switchServer).not.toHaveBeenCalled()
    expect(setVisibleHosts).not.toHaveBeenCalled()
    fireEvent.click(privateHost)
    await waitFor(() => expect(switchServer).toHaveBeenCalledExactlyOnceWith('priv'))
  })

  it('shows a lost connection and keeps the context unchanged when reconnect fails', async () => {
    store.setState({
      runtimeStatusByEnvironmentId: new Map([
        [
          'work',
          {
            status: null,
            remoteControl: {
              state: 'reconnecting',
              pendingRequestCount: 0,
              subscriptionCount: 0,
              reconnectAttempt: 2,
              lastConnectedAt: Date.now() - 1000,
              lastClose: { code: 1006, reason: 'Connection closed' },
              lastError: null
            }
          }
        ]
      ])
    })
    connectHost.mockResolvedValue(false)
    renderSegment()
    await openMenu()
    const work = screen.getByRole('menuitemradio', { name: 'Work server' })
    expect(work.textContent).toContain('Reconnecting')
    expect(work.getAttribute('aria-checked')).toBe('true')
    expect(work.getAttribute('aria-disabled')).toBe('true')
    const row = within(work.parentElement ?? work)
    fireEvent.click(row.getByRole('menuitem', { name: 'Reconnect' }))
    await waitFor(() => expect(connectHost).toHaveBeenCalledExactlyOnceWith('work', 5000))
    expect(switchServer).not.toHaveBeenCalled()
    expect(setVisibleHosts).not.toHaveBeenCalled()
    expect(work.textContent).toContain('Reconnecting')
  })

  it.each(['unpaired', 'ephemeral-only', 'paired-web', 'loading'])(
    'does not expose active-server selection for %s clients',
    async (mode) => {
      if (mode === 'unpaired') {
        store.setState({ runtimeEnvironments: [] })
      }
      if (mode === 'ephemeral-only') {
        store.setState({
          runtimeEnvironments: [{ id: 'temporary', name: 'Temporary VM', source: 'ephemeral-vm' }]
        })
      }
      if (mode === 'paired-web') {
        pairedWebClient.value = true
      }
      if (mode === 'loading') {
        store.setState({ settings: null })
      }
      renderSegment()
      if (screen.queryByRole('button')) {
        await openMenu()
      }
      expect(screen.queryByRole('menuitemradio')).toBeNull()
    }
  )
})
