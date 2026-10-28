import {
  temporarilySetNavigatorUserAgent,
  sendTerminalInputThroughPane
} from '../test-fixtures/pty-connection-test-dom'
import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
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
  loadFreshTerminalModules,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

export function registerPtyConnectionForegroundFrameSchedulingTests(): void {
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

    it('clears the synchronized latch when ConPTY splits the frame end marker', async () => {
      // Split DEC 2026 closes must release the foreground latch or later output freezes until blur (#8754).
      const restoreNavigator = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      try {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks10 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
        const transport = createMockTransport()
        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-id'
          }
        )
        transportFactoryQueue.push(transport)

        const pane = createPane(1)
        connectPanePty(
          ...mockPanePtyArgs(
            pane,
            createManager(1),
            bindPaneAgentTitleMocks(createDeps(), agentTitleMocks10)
          )
        )
        await flushAsyncTicks(6)

        vi.useFakeTimers()
        const repaintBody = 'codex spinner '.repeat(200)
        capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
        vi.advanceTimersByTime(300)
        pane.terminal.write.mockClear()

        capturedDataCallback.current?.(`${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?202`)
        capturedDataCallback.current?.('6l')
        vi.advanceTimersByTime(1100)
        expect(pane.terminal.write).toHaveBeenCalled()
        pane.terminal.write.mockClear()

        capturedDataCallback.current?.('command finished\r\n')
        vi.advanceTimersByTime(20)
        expect(pane.terminal.write).toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
        restoreNavigator()
      }
    })

    it('does not leak the interactive latch across a same-chunk close+open to a stale frame', async () => {
      // Why: a same-chunk close+open re-evaluates the new frame from its own open time so it can't inherit the prior frame's fast path.
      const restoreNavigator = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      try {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks11 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
        const transport = createMockTransport()
        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-id'
          }
        )
        transportFactoryQueue.push(transport)

        const pane = createPane(1)
        connectPanePty(
          ...mockPanePtyArgs(
            pane,
            createManager(1),
            bindPaneAgentTitleMocks(createDeps(), agentTitleMocks11)
          )
        )
        await flushAsyncTicks(6)

        vi.useFakeTimers()
        // Keep the interactive frame open: the faulty !active branch only leaks when a prior frame is still active.
        sendTerminalInputThroughPane(pane, '\r')
        const repaintBody = 'opencode repaint '.repeat(200)
        expect(repaintBody.length).toBeGreaterThan(2048)
        capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
        // Move past the 400ms interactive window without closing the frame, so any new frame now classifies non-interactive.
        vi.advanceTimersByTime(500)
        pane.terminal.write.mockClear()

        // Close and reopen after the interactive window; classify the new frame from its own start time.
        capturedDataCallback.current?.(`\x1b[?2026l\x1b[?2026h${repaintBody}`)
        vi.advanceTimersByTime(40)
        pane.terminal.write.mockClear()

        const staleEndChunk = `${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?2026l`
        expect(staleEndChunk.length).toBeGreaterThan(2048)
        capturedDataCallback.current?.(staleEndChunk)

        vi.advanceTimersByTime(20)
        expect(pane.terminal.write).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1000)
        expect(pane.terminal.write).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
        restoreNavigator()
      }
    })

    it('does not forward restored output mode controls to the PTY', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks12 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-1')
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(createDeps(), agentTitleMocks12)
        )
      )
      await flushAsyncTicks(6)
      sendTerminalInputThroughPane(pane, '\x1b[?1002h\x1b[>4;2m')

      expect(transport.sendInput).not.toHaveBeenCalled()

      sendTerminalInputThroughPane(pane, '\x1b[A')

      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[A', 'query-reply')
    })
  })
}
