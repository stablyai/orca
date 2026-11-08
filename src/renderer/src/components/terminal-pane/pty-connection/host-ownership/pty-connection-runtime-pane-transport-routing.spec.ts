import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_1,
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

export function registerPtyConnectionRuntimePaneTransportRoutingTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }
  describe('connectPanePty', () => {
    beforeEach(async () => {
      vi.clearAllMocks()
      transportFactoryQueue = []
      createdTransportOptions = []
      storeSubscribers = []
      mockStoreState = createInitialStoreState(() => mockStoreState)
      bindPtyConnectionTestMocks({
        getState: () => mockStoreState,
        getTransportQueue: () => transportFactoryQueue,
        getTransportOptions: () => createdTransportOptions,
        getStoreSubscribers: () => storeSubscribers,
        setStoreSubscribers: (subscribers) => {
          storeSubscribers = subscribers
        }
      })
      await installTerminalTestGlobals()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('uses a paired-web pane owner to disambiguate duplicate HUB projections', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks8 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const tabId = 'web-terminal-host-tab'
      const ptyId = 'remote:hub-b@@terminal-1'
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: tabId, ptyId }] },
        worktreesByRepo: {
          repo1: [
            { id: 'wt-1', repoId: 'repo1', path: '/srv/wt-1', hostId: 'local' },
            {
              id: 'wt-1',
              repoId: 'repo1',
              path: '/srv/wt-1',
              hostId: 'ssh:private-target',
              runtimeOwnerEnvironmentId: 'hub-b'
            }
          ]
        }
      } as StoreState

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(
          createDeps({
            tabId,
            restoredLeafId: LEAF_1,
            restoredPtyIdByLeafId: { [LEAF_1]: ptyId }
          }) as never,
          agentTitleMocks8
        )
      )

      expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('hub-b', expect.any(Object))
    })

    it('withholds a local spawn while a repo-backed worktree has no hydrated host', async () => {
      // Missing SSH repo metadata must defer resolution rather than spawn remote cwd paths on the local daemon.
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks14 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-remote': [{ id: 'tab-1', ptyId: null }] },
        // Why: the worktree row exists (so the owner is not "ambiguous") but its repo has
        // not landed yet — exactly the window that used to fail open to local.
        worktreesByRepo: {
          repo1: [{ id: 'wt-remote', repoId: 'repo1', path: '/tmp/orca-docker-relay-perf-repo' }]
        },
        repos: []
      } as StoreState

      const deps = createDeps({
        worktreeId: 'wt-remote',
        cwd: '/tmp/orca-docker-relay-perf-repo'
      })
      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks14)
      )

      expect(createIpcPtyTransport).not.toHaveBeenCalled()
      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    })

    it('routes a HUB-owned SSH PTY wake hint through the HUB without direct SSH', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks16 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const hostPtyId = 'ssh:hub-private@@pty-2'
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: hostPtyId }]
        },
        ptyIdsByTabId: { 'tab-1': [hostPtyId] },
        terminalLayoutsByTabId: {
          'tab-1': {
            root: { type: 'leaf', leafId: LEAF_1 },
            activeLeafId: LEAF_1,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_1]: hostPtyId }
          }
        },
        worktreesByRepo: {
          repo1: [
            {
              id: 'wt-1',
              repoId: 'repo1',
              path: '/srv/wt-1',
              hostId: 'ssh:hub-private',
              runtimeOwnerEnvironmentId: 'hub-env'
            }
          ]
        },
        repos: [
          {
            id: 'repo1',
            connectionId: 'hub-private',
            executionHostId: 'runtime:hub-env'
          }
        ]
      } as StoreState
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: hostPtyId }
      })

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks16)
      )
      await flushAsyncTicks()

      expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('hub-env', expect.any(Object))
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: hostPtyId })
      )
      expect(transport.attach).not.toHaveBeenCalled()
      expect(window.api.ssh.connect).not.toHaveBeenCalled()
      expect(window.api.ssh.needsPassphrasePrompt).not.toHaveBeenCalled()
    })
  })
}
