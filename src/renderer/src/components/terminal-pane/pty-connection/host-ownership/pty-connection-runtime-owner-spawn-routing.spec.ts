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

export function registerPtyConnectionRuntimeOwnerSpawnRoutingTests(): void {
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

    it('fails closed when the same SSH worktree id is projected by two HUBs', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        worktreesByRepo: {
          repo1: [
            {
              id: 'wt-1',
              repoId: 'repo1',
              path: '/srv/same-worktree',
              hostId: 'ssh:same-private-target',
              runtimeOwnerEnvironmentId: 'hub-a'
            },
            {
              id: 'wt-1',
              repoId: 'repo1',
              path: '/srv/same-worktree',
              hostId: 'ssh:same-private-target',
              runtimeOwnerEnvironmentId: 'hub-b'
            }
          ]
        },
        settings: {
          ...mockStoreState.settings,
          activeRuntimeEnvironmentId: 'hub-a'
        }
      } as StoreState

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(
          createDeps({ restoredPtyIdByLeafId: { [LEAF_1]: null } }) as never,
          agentTitleMocks
        )
      )
      await flushAsyncTicks()

      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
      expect(createIpcPtyTransport).not.toHaveBeenCalled()
      expect(window.api.ssh.connect).not.toHaveBeenCalled()
      expect(window.api.ssh.needsPassphrasePrompt).not.toHaveBeenCalled()
    })

    it('fails a missing paired-client owner closed instead of creating a local PTY', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks2 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        worktreesByRepo: {
          repo1: [{ id: 'wt-1', repoId: 'repo1', path: '/srv/stale-worktree' }]
        },
        runtimeEnvironments: [{ id: 'hub-a' }, { id: 'hub-b' }],
        runtimeEnvironmentCatalogHydrated: true,
        settings: { ...mockStoreState.settings, activeRuntimeEnvironmentId: 'hub-a' }
      } as StoreState

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(
          createDeps({ restoredPtyIdByLeafId: { [LEAF_1]: null } }) as never,
          agentTitleMocks2
        )
      )
      await flushAsyncTicks()

      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
      expect(createIpcPtyTransport).not.toHaveBeenCalled()
      expect(window.api.ssh.connect).not.toHaveBeenCalled()
    })

    it('spawns fresh PTYs through the worktree owner runtime when focus differs', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const transport = createMockTransport('remote:owner-runtime@@terminal-1')
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: null }]
        },
        repos: [
          {
            id: 'repo1',
            connectionId: null,
            displayName: 'orca',
            executionHostId: 'runtime:owner-runtime'
          }
        ],
        settings: {
          ...mockStoreState.settings,
          activeRuntimeEnvironmentId: 'focused-runtime'
        }
      } as StoreState

      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps({
        startup: {
          command: "codex '--profile' 'recipe'",
          launchAgent: 'codex',
          launchConfig: { agentArgs: '--profile recipe', agentEnv: {} },
          agentArgsOverride: '--profile recipe'
        }
      })

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks3)
      )

      expect(createRemoteRuntimePtyTransport).toHaveBeenCalledWith(
        'owner-runtime',
        expect.any(Object)
      )
      expect(createdTransportOptions[0]?.cwdFallback).toBeUndefined()
      expect(createdTransportOptions[0]?.agentArgsOverride).toBe('--profile recipe')
      expect(transport.connect).toHaveBeenCalled()
    })

    it('spawns fresh PTYs locally for explicitly local worktrees while a runtime is focused', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const { createRemoteRuntimePtyTransport } =
        await import('../../pty-transport/remote-runtime/remote-runtime-pty-transport')
      const { createIpcPtyTransport } = await import('../../pty-transport/ipc/pty-transport')
      const transport = createMockTransport('pty-local-1')
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: null }]
        },
        repos: [
          {
            id: 'repo1',
            connectionId: null,
            displayName: 'orca',
            executionHostId: 'local'
          }
        ],
        settings: {
          ...mockStoreState.settings,
          activeRuntimeEnvironmentId: 'focused-runtime'
        }
      } as StoreState

      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks4)
      )

      expect(createRemoteRuntimePtyTransport).not.toHaveBeenCalled()
      expect(createIpcPtyTransport).toHaveBeenCalled()
      expect(createdTransportOptions[0]).not.toHaveProperty('cwdFallback')
      expect(transport.connect).toHaveBeenCalled()
    })
  })
}
