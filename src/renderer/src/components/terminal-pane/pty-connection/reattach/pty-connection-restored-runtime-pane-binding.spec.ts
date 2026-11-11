import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_1,
  LEAF_2,
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

export function registerPtyConnectionRestoredRuntimePaneBindingTests(): void {
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

    it('attaches restored remote PTYs for later split panes instead of spawning host tabs', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const existingTransport = createMockTransport('remote:env-1@@terminal-1')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'remote:env-1@@terminal-1' }]
        },
        settings: {
          ...mockStoreState.settings,
          activeRuntimeEnvironmentId: 'env-1'
        }
      } as StoreState

      const paneTransports = new Map([[1, existingTransport]])
      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: {
          [LEAF_2]: 'remote:env-1@@terminal-2'
        },
        paneTransportsRef: { current: paneTransports }
      })

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks6)
      )

      expect(transport.connect).not.toHaveBeenCalled()
      expect(transport.attach).toHaveBeenCalledWith(
        expect.objectContaining({ existingPtyId: 'remote:env-1@@terminal-2' })
      )
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'remote:env-1@@terminal-2')
    })

    it('publishes a restarted pane PTY id and reuses its restored hint on remount', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks7 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )

      const restartedTransport = createMockTransport()
      let spawnedPtyId: string | null = null
      restartedTransport.connect.mockImplementation(async () => {
        spawnedPtyId = 'pty-restarted'
        const opts = createdTransportOptions[0]
        ;(opts.onPtySpawn as (ptyId: string) => void)('pty-restarted')
        return 'pty-restarted'
      })
      transportFactoryQueue.push(restartedTransport)

      const restartPane = createPane(1)
      const restartManager = createManager(1)
      const restartDeps = createDeps({
        paneTransportsRef: { current: new Map([[99, createMockTransport('another-pane-pty')]]) }
      })

      connectPanePty(
        restartPane as never,
        restartManager as never,
        bindPaneAgentTitleMocks(restartDeps as never, agentTitleMocks7)
      )
      await flushAsyncTicks()

      expect(spawnedPtyId).toBe('pty-restarted')
      expect(restartDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-restarted')

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'pty-restarted' }]
        },
        settings: {
          ...mockStoreState.settings
        }
      }

      const remountTransport = createMockTransport()
      transportFactoryQueue.push(remountTransport)
      const remountPane = createPane(1)
      const remountManager = createManager(1)
      const remountDeps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'pty-restarted' }
      })

      connectPanePty(
        remountPane as never,
        remountManager as never,
        bindPaneAgentTitleMocks(remountDeps as never, agentTitleMocks7)
      )

      expect(remountTransport.connect).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'pty-restarted' })
      )
      expect(remountTransport.attach).not.toHaveBeenCalled()
      await Promise.resolve()
      expect(remountDeps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(1, 'pty-restarted')
    })
  })
}
