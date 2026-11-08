import {
  bindPtyConnectionTestMocks,
  ptyConnectionTestMocks
} from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
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
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

export function registerPtyConnectionHiddenOutputSchedulingTests(): void {
  const { resetAndRefreshAllTerminalWebglAtlases, scheduleTerminalWebglAtlasRecovery } =
    ptyConnectionTestMocks

  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  function expectNoGlobalAtlasRecovery(): void {
    // Why: the removed output path requested recovery 200ms before its global reset ran.
    expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
    expect(resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()
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

    it('keeps split hidden synchronized output off the global atlas recovery path', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks2 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false }
            }),
            agentTitleMocks2
          )
        )
      )
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      try {
        capturedDataCallback.current?.('\x1b[?202')
        capturedDataCallback.current?.('6hbody row\r\n')
        capturedDataCallback.current?.('tail\x1b[?20')
        capturedDataCallback.current?.('26l')

        vi.advanceTimersByTime(50)

        expect(writes.join('')).toBe('\x1b[?2026hbody row\r\ntail\x1b[?2026l')

        parseCallbacks[0]?.()
        expectNoGlobalAtlasRecovery()
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps a background-origin alternate-screen chunk in the stream, pane-local', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: {
        current: ((data: string, meta?: { background?: boolean }) => void) | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
      const isVisibleRef = { current: false }

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef
            }),
            agentTitleMocks6
          )
        )
      )
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      try {
        capturedDataCallback.current?.('\x1b[?2026h')
        vi.advanceTimersByTime(50)
        parseCallbacks.shift()?.()
        writes.length = 0

        isVisibleRef.current = true
        ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
        capturedDataCallback.current?.('\x1b[?2026l', { background: true })
        expect(writes).toEqual([])

        isVisibleRef.current = false
        ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'normal'
        capturedDataCallback.current?.('plain after close\r\n')
        vi.advanceTimersByTime(50)
        parseCallbacks.shift()?.()

        // Dropping the close would strand xterm inside synchronized output.
        expect(writes).toEqual(['\x1b[?2026lplain after close\r\n'])
        expectNoGlobalAtlasRecovery()
      } finally {
        vi.useRealTimers()
      }
    })
  })
}
