import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
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

export function registerPtyConnectionTerminalBellAttentionTests(): void {
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

    it('forwards onBell to pane attention and notification policy', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks8 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      vi.useFakeTimers()
      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks8)
      )

      const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
      if (!bellHandler) {
        throw new Error('Expected onBell to be registered')
      }

      bellHandler()

      expect(deps.markTerminalBell).toHaveBeenCalledTimes(1)
      expect(deps.markTerminalBell).toHaveBeenCalledWith({
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        paneKey: makePaneKey('tab-1', LEAF_1)
      })
      expect(deps.dispatchNotification).not.toHaveBeenCalled()
      vi.advanceTimersByTime(250)
      expect(deps.dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'terminal-bell',
          paneKey: makePaneKey('tab-1', LEAF_1)
        })
      )
    })

    it('hands the bell to the attention module with its pane even when pane attention is off', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks9 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState.settings = {
        ...mockStoreState.settings,
        experimentalTerminalAttention: false
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks9)
      )

      const bellHandler = createdTransportOptions[0]?.onBell as (() => void) | undefined
      if (!bellHandler) {
        throw new Error('Expected onBell to be registered')
      }

      bellHandler()

      // Why: the experimental pane gate lives in the workspace-attention module, not the PTY binding.
      expect(deps.markTerminalBell).toHaveBeenCalledTimes(1)
      expect(deps.markTerminalBell).toHaveBeenCalledWith({
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        paneKey: makePaneKey('tab-1', LEAF_1)
      })
    })
  })
}
