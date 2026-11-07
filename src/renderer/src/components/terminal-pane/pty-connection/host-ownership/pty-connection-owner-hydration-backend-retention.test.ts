import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { makeTab } from '@/store/slices/store-session-test-harness'
import { createPaneManagerOptionsTestContext } from '../../mounting/terminal-pane-manager-options-test-context'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
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
  const { buildAgentStatusModuleMock } =
    await import('../test-fixtures/pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('../../titles/cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/agent-session/accounts/codex/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('../../pty-transport/ipc/pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('../../pty-transport/remote-runtime/remote-runtime-pty-transport', () => ({
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

vi.mock('../../pty-transport/delivery/pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
})
describe('connectPanePty owner hydration and backend retention', () => {
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
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
    const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
    const { createRemoteRuntimePtyTransport } =
      await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
    const { createTerminalPaneManagerOptions } =
      await import('../../mounting/terminal-pane-manager-options')
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
    bindPaneAgentTitleMocks(args[2], agentTitleMocks)

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
    bindPaneAgentTitleMocks(args[2], agentTitleMocks)

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

  it.each([
    { rowless: true, remote: false },
    { rowless: true, remote: true },
    { rowless: false, remote: false },
    { rowless: false, remote: true }
  ])(
    'retains the connect owner through focus changes ($rowless, $remote)',
    async ({ rowless, remote }) => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createTerminalPaneManagerOptions } =
        await import('../../mounting/terminal-pane-manager-options')
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
      bindPaneAgentTitleMocks(args[2], agentTitleMocks5)

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
