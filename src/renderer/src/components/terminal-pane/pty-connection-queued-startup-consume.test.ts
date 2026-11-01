import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { makeTab } from '@/store/slices/store-session-test-harness'
import { createPaneManagerOptionsTestContext } from './terminal-pane-manager-options-test-context'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({ scheduleTerminalWebglAtlasRecovery }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const transport = transportFactoryQueue.shift()
      if (!transport) {
        throw new Error('No remote mock transport queued')
      }
      return transport
    }
  )
}))

vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
})

function spawnOnConnect(transport: MockTransport, ptyId: string): void {
  transport.connect.mockImplementation(async () => {
    const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as ((id: string) => void) | undefined
    onPtySpawn?.(ptyId)
    return ptyId
  })
}

// Consume queued startup only after first fresh PTY binding: earlier consumption can force-park mid-spawn; later respawn consumption could erase a new command (STA-4876).
describe('connectPanePty queued startup consume', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
    vi.unstubAllGlobals()
  })

  it('parks an unknown owner until hydration, then retains the acquired backend on refresh', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { createIpcPtyTransport } = await import('./pty-transport')
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const { createTerminalPaneManagerOptions } = await import('./terminal-pane-manager-options')
    const { clearTerminalTabsParkedOnUnresolvedHost, getTabIdsAwaitingHostHydrationRemount } =
      await import('@/lib/parked-terminal-host-hydration')
    clearTerminalTabsParkedOnUnresolvedHost()
    const worktree = makeWorktree({ id: 'wt-hydrating', repoId: TEST_REPO.id, hostId: undefined })
    const tab = makeTab({ id: 'tab-1', worktreeId: worktree.id, ptyId: null })
    mockStoreState.repos = []
    mockStoreState.worktreesByRepo = { [TEST_REPO.id]: [worktree] }
    mockStoreState.tabsByWorktree = { [worktree.id]: [tab] }
    mockStoreState.ptyIdsByTabId = {}
    const deps = buildPaneConnectionDeps(() => mockStoreState, { worktreeId: worktree.id })
    const pane = createPane(1)
    const args = mockPanePtyArgs(pane, createManager(1), deps)
    const parked = connectPanePty(...args)
    expect(parked.getOwnerContext().executionHostId).toBe('runtime:unresolved-owner')
    expect(createIpcPtyTransport).not.toHaveBeenCalled()
    expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    const hydrationState = {
      repos: [],
      folderWorkspaces: [],
      projectGroups: [],
      worktreesByRepo: { [TEST_REPO.id]: [worktree] },
      tabsByWorktree: { [worktree.id]: [tab] },
      ptyIdsByTabId: {}
    }
    expect(getTabIdsAwaitingHostHydrationRemount(hydrationState)).toEqual([])
    const repo = { ...TEST_REPO, executionHostId: 'runtime:server' as const }
    mockStoreState.repos = [repo]
    mockStoreState.runtimeEnvironments = [{ id: 'server' }]
    expect(getTabIdsAwaitingHostHydrationRemount({ ...hydrationState, repos: [repo] })).toEqual([
      'tab-1'
    ])
    parked.dispose()
    transportFactoryQueue.push(createMockTransport())
    const binding = connectPanePty(...args)
    const captured = binding.getOwnerContext()
    expect(captured.executionHostId).toBe('runtime:server')
    expect(createRemoteRuntimePtyTransport).toHaveBeenCalledExactlyOnceWith(
      'server',
      expect.any(Object)
    )
    expect(createIpcPtyTransport).not.toHaveBeenCalled()
    mockStoreState.settings = { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'other' }
    const context = createPaneManagerOptionsTestContext(args[2], binding, deps.cwd)
    const options = createTerminalPaneManagerOptions(context)
    if (typeof options.terminalOptions === 'function') {
      options.terminalOptions(1)
    }
    expect(binding.getOwnerContext()).toBe(captured)
    binding.dispose()
    clearTerminalTabsParkedOnUnresolvedHost()
  })

  it('spends the queued startup only after the pty is bound to the tab', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    spawnOnConnect(transport, 'fresh-pty')
    transportFactoryQueue.push(transport)

    const callOrder: string[] = []
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      startup: { command: 'echo queued' },
      updateTabPtyId: vi.fn(() => {
        callOrder.push('updateTabPtyId')
      }),
      onQueuedStartupSpawned: vi.fn(() => {
        callOrder.push('onQueuedStartupSpawned')
      })
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    expect(callOrder).toContain('onQueuedStartupSpawned')
    expect(callOrder.indexOf('updateTabPtyId')).toBeGreaterThanOrEqual(0)
    expect(callOrder.indexOf('updateTabPtyId')).toBeLessThan(
      callOrder.indexOf('onQueuedStartupSpawned')
    )
  })

  it('leaves the queued startup unspent when the spawn never reaches onPtySpawn', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    // A retired/reattached spawn resolves without ever announcing a fresh pty.
    transport.connect.mockImplementation(async () => undefined)
    transportFactoryQueue.push(transport)

    const onQueuedStartupSpawned = vi.fn()
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      startup: { command: 'echo queued' },
      onQueuedStartupSpawned
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    // The next mount must still find the command queued, or it is lost for good.
    expect(onQueuedStartupSpawned).not.toHaveBeenCalled()
  })

  it('keeps a throwing consume from escaping into the spawn', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport()
    // onPtySpawn runs inside connect; callback throws would reject spawn and strand the pane, so cleanup must not throw.
    let escapedIntoSpawn = false
    transport.connect.mockImplementation(async () => {
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((id: string) => void)
        | undefined
      try {
        onPtySpawn?.('fresh-pty')
      } catch {
        escapedIntoSpawn = true
        return undefined
      }
      return 'fresh-pty'
    })
    transportFactoryQueue.push(transport)

    const updateTabPtyId = vi.fn()
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      startup: { command: 'echo queued' },
      updateTabPtyId,
      onQueuedStartupSpawned: vi.fn(() => {
        throw new Error('store blew up')
      })
    })

    connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(20)

    expect(escapedIntoSpawn).toBe(false)
    expect(updateTabPtyId).toHaveBeenCalled()
  })

  it.each([
    { rowless: true, remote: false },
    { rowless: true, remote: true },
    { rowless: false, remote: false },
    { rowless: false, remote: true }
  ])(
    'retains the connect owner through focus changes ($rowless, $remote)',
    async ({ rowless, remote }) => {
      const { connectPanePty } = await import('./pty-connection')
      const { createTerminalPaneManagerOptions } = await import('./terminal-pane-manager-options')
      vi.stubGlobal('navigator', { userAgent: 'Windows' })
      const worktreeId = rowless ? 'ephemeral-setup-terminal:install' : 'repo1::/tmp/wt-1'
      if (!rowless) {
        mockStoreState.worktreesByRepo = {
          repo1: [
            {
              id: worktreeId,
              repoId: 'repo1',
              path: '/tmp/wt-1',
              hostId: remote ? 'runtime:server' : 'local'
            }
          ]
        }
      }
      mockStoreState.tabsByWorktree[worktreeId] = [{ id: 'tab-1', ptyId: null }]
      mockStoreState.settings = {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: remote ? 'server' : null
      }
      mockStoreState.runtimeEnvironments = remote ? [{ id: 'server' }] : []
      if (!rowless && remote) {
        mockStoreState.repos = mockStoreState.repos.map((repo) => ({
          ...repo,
          executionHostId: 'runtime:server'
        }))
      }
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const deps = buildPaneConnectionDeps(() => mockStoreState, { worktreeId })
      const pane = createPane(1)
      const args = mockPanePtyArgs(pane, createManager(1), deps)
      const binding = connectPanePty(...args)
      const captured = binding.getOwnerContext()
      expect(captured.route).toEqual({ runtimeEnvironmentId: remote ? 'server' : null })
      expect(captured.executionHostId).toBe(remote ? 'runtime:server' : 'local')
      expect(captured.connectionId).toBe(rowless ? undefined : null)
      const localConpty = !rowless && !remote
      expect(pane.terminal.options.windowsPty).toEqual(
        localConpty ? { backend: 'conpty', buildNumber: 26100 } : undefined
      )
      expect(createdTransportOptions[0]?.terminalKittyKeyboardProtocol).toBe(!localConpty)
      const tracker = deps.paneKittyKeyboardModesRef.current.get(1)
      expect(tracker).toBeDefined()
      tracker?.restoreSnapshotFlags(1)
      expect(tracker?.flags).toBe(localConpty ? 0 : 1)
      mockStoreState.settings = {
        ...mockStoreState.settings,
        activeRuntimeEnvironmentId: remote ? null : 'other'
      }
      mockStoreState.runtimeEnvironments = remote ? [] : [{ id: 'other' }]
      const context = createPaneManagerOptionsTestContext(args[2], binding, deps.cwd)
      const options = createTerminalPaneManagerOptions(context)
      const refreshed =
        typeof options.terminalOptions === 'function'
          ? options.terminalOptions(1)
          : options.terminalOptions
      expect(binding.getOwnerContext()).toBe(captured)
      expect(refreshed?.windowsPty).toEqual(pane.terminal.options.windowsPty)
      expect(refreshed?.vtExtensions).toEqual(localConpty ? { kittyKeyboard: false } : undefined)
      binding.dispose()
    }
  )
})
