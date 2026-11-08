import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
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

export function registerPtyConnectionCommandCodeStatusInferenceTests(): void {
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

    it('marks a Command Code no-tool turn done after the idle prompt settles', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-command-code')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-command-code'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: 'command-code --trust'
        }
      })
      const paneKey = makePaneKey('tab-1', LEAF_1)

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks5)
      )
      vi.runOnlyPendingTimers()
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('❯ say hi\r\n✻ Thinking...')
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'working',
        prompt: 'say hi',
        agentType: 'command-code'
      })

      capturedDataCallback.current?.(
        '\r\n✻ Thought for 1 second\r\n:: Hi! How can I help you today?\r\n❯ Ask your question...'
      )
      vi.advanceTimersByTime(1499)
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'working',
        prompt: 'say hi',
        agentType: 'command-code'
      })

      vi.advanceTimersByTime(1)
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'done',
        prompt: 'say hi',
        agentType: 'command-code'
      })
    })

    it('keeps Command Code working when an active repaint follows the idle prompt before settle', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-command-code')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-command-code'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: 'command-code --trust'
        }
      })
      const paneKey = makePaneKey('tab-1', LEAF_1)

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks6)
      )
      vi.runOnlyPendingTimers()
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()

      capturedDataCallback.current?.('❯ Run a slow command\r\n✻ Thinking...')
      capturedDataCallback.current?.('\r\n❯ Ask your question...')
      vi.advanceTimersByTime(1000)
      capturedDataCallback.current?.('\r\n✧ Investigating... esc to interrupt')
      vi.advanceTimersByTime(500)

      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'working',
        prompt: 'Run a slow command',
        agentType: 'command-code'
      })
    })
  })
}
