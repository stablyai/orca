import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { sendTerminalInputThroughPane } from '../test-fixtures/pty-connection-test-dom'
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

export function registerPtyConnectionDeferredInputForwardingTests(): void {
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

    it('routes terminal input through deferPtyInput so the host can withhold it', async () => {
      // Regression: inlining forwardPtyInput into onData dropped this hop, silently disabling link-click mouse suppression.
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const pane = createPane(1)
      const transport = createMockTransport('pty-1')
      transportFactoryQueue.push(transport)
      const deferPtyInput = vi.fn()

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(createDeps({ deferPtyInput }), agentTitleMocks4)
        )
      )
      await flushAsyncTicks()
      sendTerminalInputThroughPane(pane, 'a')

      expect(deferPtyInput).toHaveBeenCalledWith(1, 'a', expect.any(Function))
      expect(transport.sendInput).not.toHaveBeenCalled()

      const forward = deferPtyInput.mock.calls[0]?.[2] as (data: string) => void
      forward('a')
      expect(transport.sendInput).toHaveBeenCalledWith('a', 'query-reply')
    })

    it('forwards terminal input directly when the host supplies no deferPtyInput', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const pane = createPane(1)
      const transport = createMockTransport('pty-1')
      transportFactoryQueue.push(transport)

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(createDeps(), agentTitleMocks5)
        )
      )
      await flushAsyncTicks()
      sendTerminalInputThroughPane(pane, 'a')

      expect(transport.sendInput).toHaveBeenCalledWith('a', 'query-reply')
    })
  })
}
