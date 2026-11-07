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
      vi.resetModules()
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

    it('does not let a restored encoded PTY override the current worktree owner', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'remote:env-1@@terminal-1' }]
        },
        worktreesByRepo: {
          repo1: [
            {
              id: 'wt-1',
              repoId: 'repo1',
              path: '/tmp/wt-1',
              displayName: 'feat/notis',
              runtimeOwnerEnvironmentId: 'env-2'
            }
          ]
        },
        settings: {
          ...mockStoreState.settings,
          activeRuntimeEnvironmentId: 'env-2'
        }
      } as StoreState

      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks6)
      )

      expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('env-2', expect.any(Object))
      expect(transport.attach).toHaveBeenCalledWith(
        expect.objectContaining({ existingPtyId: 'remote:env-1@@terminal-1' })
      )
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'remote:env-1@@terminal-1')
    })

    it('routes a paired-web mirrored pane through its session-scoped HUB owner', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks7 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const tabId = 'web-terminal-host-tab'
      const ptyId = 'remote:hub-web@@terminal-1'
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: tabId, ptyId }] },
        ptyIdsByTabId: { [tabId]: [ptyId] },
        worktreesByRepo: {
          repo1: [
            {
              id: 'wt-1',
              repoId: 'repo1',
              path: '/srv/wt-1',
              hostId: 'local'
            }
          ]
        },
        repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }]
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
          agentTitleMocks7
        )
      )

      expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('hub-web', expect.any(Object))
      expect(createIpcPtyTransport).not.toHaveBeenCalled()
      expect(transport.attach).toHaveBeenCalledWith(
        expect.objectContaining({ existingPtyId: ptyId })
      )
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

    it('ignores a stale runtime PTY on an explicitly local non-web pane', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks9 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const ptyId = 'remote:stale-hub@@terminal-1'
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
        worktreesByRepo: {
          repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
        },
        repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
        settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'stale-hub' }
      } as StoreState

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks9)
      )

      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
      expect(createIpcPtyTransport).toHaveBeenCalled()
    })

    it('spawns an unstamped local worktree locally while a single server is focused', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks10 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        worktreesByRepo: {
          repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/srv/wt-1' }]
        },
        repos: [{ id: 'repo1', connectionId: null }],
        settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'legacy-hub' }
      } as StoreState

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks10)
      )

      // Why: the client stamps every server row on arrival, so an unstamped row is this machine's.
      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
      expect(createIpcPtyTransport).toHaveBeenCalled()
    })

    it('runs an inline setup terminal locally instead of failing its host closed', async () => {
      // Synthetic setup IDs have no catalog row; they must resolve locally instead of failing strict ownership as ambiguous (#9994).
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks11 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const setupWorktreeId =
        'ephemeral-setup-terminal:settings-mobile-emulator-orca-cli-skill-terminal'
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { [setupWorktreeId]: [{ id: 'tab-1', ptyId: null }] },
        worktreesByRepo: {
          repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
        },
        repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }]
      } as StoreState

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(
          createDeps({ worktreeId: setupWorktreeId }) as never,
          agentTitleMocks11
        )
      )

      expect(createIpcPtyTransport).toHaveBeenCalled()
      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
    })

    it('runs an inline setup terminal on the single active runtime for remote skill installs', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks12 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      const setupWorktreeId =
        'ephemeral-setup-terminal:settings-mobile-emulator-orca-cli-skill-terminal'
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { [setupWorktreeId]: [{ id: 'tab-1', ptyId: null }] },
        worktreesByRepo: {
          repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
        },
        repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
        runtimeEnvironments: [{ id: 'hub-a' }],
        settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'hub-a' }
      } as StoreState

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(
          createDeps({ worktreeId: setupWorktreeId }) as never,
          agentTitleMocks12
        )
      )

      expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith('hub-a', expect.any(Object))
    })

    it('still spawns locally when the worktree row itself proves a local host', async () => {
      // A local-stamped worktree already names its host before its repo hydrates.
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks13 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-local': [{ id: 'tab-1', ptyId: null }] },
        worktreesByRepo: {
          repo1: [{ id: 'wt-local', repoId: 'repo1', path: '/tmp/wt-local', hostId: 'local' }]
        },
        repos: []
      } as StoreState

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(
          createDeps({ worktreeId: 'wt-local', cwd: '/tmp/wt-local' }) as never,
          agentTitleMocks13
        )
      )

      expect(createIpcPtyTransport).toHaveBeenCalled()
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

    it('keeps the floating terminal local even while a runtime is active', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks15 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'global-floating-terminal': [{ id: 'tab-1', ptyId: null }] },
        worktreesByRepo: {
          repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/tmp/wt-1', hostId: 'local' }]
        },
        repos: [{ id: 'repo1', connectionId: null, executionHostId: 'local' }],
        runtimeEnvironments: [{ id: 'hub-a' }],
        settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'hub-a' }
      } as StoreState

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(
          createDeps({ worktreeId: 'global-floating-terminal' }) as never,
          agentTitleMocks15
        )
      )

      expect(createIpcPtyTransport).toHaveBeenCalled()
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
