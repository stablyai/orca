import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
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
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep,
  requestTerminalPaneRecovery
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn(),
  requestTerminalPaneRecovery: vi.fn(async () => true)
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

// Only the request is spied: connect still needs the real generation/instance registry.
vi.mock('../../render-health/recovery/terminal-pane-recovery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestTerminalPaneRecovery
}))

vi.mock('@/store/index', () => ({
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

vi.mock('../../titles/cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

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
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

vi.mock('../../pty-transport/delivery/pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
})

describe('fresh spawn leaves a local pane unbound', () => {
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
  })

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  it.each([false, true])(
    'mounts and remounts the tab owner while an unrelated workspace is active (%s)',
    async (reverse) => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const local = makeWorktree({ id: 'wt-1', repoId: 'repo1', path: '/local', hostId: 'local' })
      const remote = { ...local, path: '/remote', hostId: 'runtime:server' as const }
      mockStoreState.activeWorktreeId = 'unrelated'
      mockStoreState.worktreesByRepo = reverse
        ? { first: [remote], second: [local] }
        : { first: [local], second: [remote] }
      mockStoreState.repos = reverse
        ? [
            { id: 'repo1', executionHostId: 'runtime:server' },
            { id: 'repo1', executionHostId: 'local' }
          ]
        : [
            { id: 'repo1', executionHostId: 'local' },
            { id: 'repo1', executionHostId: 'runtime:server' }
          ]
      Object.assign(mockStoreState, {
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: 'unified-1',
              entityId: 'tab-1',
              contentType: 'terminal',
              executionHostId: 'runtime:server'
            }
          ]
        },
        getKnownWorktreeById: (id: string, host?: ExecutionHostId) =>
          findKnownWorktreeById(
            {
              worktreesByRepo: reverse
                ? { first: [remote], second: [local] }
                : { first: [local], second: [remote] },
              detectedWorktreesByRepo: {},
              folderWorkspaces: [],
              floatingWorkspacePath: null
            },
            id,
            host
          )
      })
      for (let mount = 0; mount < 2; mount++) {
        const pane = createPane(1)
        const transport = createMockTransport('remote:server@@pty-1')
        transportFactoryQueue.push(transport)
        const binding = connectPanePty(
          ...mockPanePtyArgs(
            pane,
            createManager(1),
            bindPaneAgentTitleMocks(createDeps(), agentTitleMocks)
          )
        )
        await flushAsyncTicks(40)
        expect(createRemoteRuntimePtyTransport).toHaveBeenLastCalledWith(
          'server',
          expect.any(Object)
        )
        expect(transport.connect).toHaveBeenCalled()
        const input = pane.terminal.onData.mock.calls.at(-1)?.[0]
        input('continue\r')
        expect(transport.sendInput).toHaveBeenCalledWith('continue\r', expect.anything())
        expect(mockStoreState.activeWorktreeId).toBe('unrelated')
        binding.dispose()
      }
    }
  )

  it.each(['local', 'runtime:server'] as const)(
    'continues a recorded live folder owner despite ambiguous inventory (%s)',
    async (host) => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks2 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const worktreeId = 'folder:ambiguous'
      Object.assign(mockStoreState, {
        folderWorkspaces: [{ id: 'ambiguous', projectGroupId: 'mixed', folderPath: '/work' }],
        projectGroups: [{ id: 'mixed', parentPath: '/work' }],
        repos: [
          { id: 'local', path: '/work/local', projectGroupId: 'mixed' },
          { id: 'ssh', path: '/work/ssh', projectGroupId: 'mixed', executionHostId: 'ssh:prod' }
        ],
        unifiedTabsByWorktree: {
          [worktreeId]: [
            { id: 'u', entityId: 'tab-1', contentType: 'terminal', executionHostId: host }
          ]
        },
        tabsByWorktree: {
          [worktreeId]: [
            { id: 'tab-1', ptyId: host === 'local' ? 'pty-local' : 'remote:server@@pty-live' }
          ]
        }
      })
      for (let mount = 0; mount < 2; mount++) {
        const transport = createMockTransport(
          host === 'local' ? 'pty-local' : 'remote:server@@pty-live'
        )
        transportFactoryQueue.push(transport)
        const pane = createPane(1)
        const binding = connectPanePty(
          ...mockPanePtyArgs(
            pane,
            createManager(1),
            bindPaneAgentTitleMocks(createDeps({ worktreeId }), agentTitleMocks2)
          )
        )
        await flushAsyncTicks(40)
        if (host === 'local') {
          expect(transport.connect).toHaveBeenCalled()
        } else {
          expect(transport.attach).toHaveBeenCalled()
        }
        pane.terminal.onData.mock.calls.at(-1)?.[0]('continue\r')
        expect(transport.sendInput).toHaveBeenCalledWith('continue\r', expect.anything())
        expect(createdTransportOptions.at(-1)?.env).not.toHaveProperty('ORCA_WORKSPACE_ROOT')
        binding.dispose()
      }
    }
  )
})
