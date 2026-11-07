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
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

export function registerPtyConnectionMode2031RawSubscriptionTests(): void {
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

    it('records a mode 2031 subscribe from the raw chunk boundary without answering', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks16 =
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
      mockStoreState = {
        ...mockStoreState,
        settings: { ...mockStoreState.settings, theme: 'light' }
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({ isVisibleRef: { current: false } }),
            agentTitleMocks16
          )
        )
      )
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      try {
        capturedDataCallback.current?.('\x1b[?2031h')
        vi.advanceTimersByTime(50)

        // Scan chunk boundaries: xterm batches chunks and cannot observe each transient subscription state (#9993).
        expect(transport.sendInput).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
        expect(transport.sendInputImmediate).not.toHaveBeenCalledWith(
          expect.stringMatching(/\?997/)
        )
        // The bytes still reach xterm so the emulator tracks the mode itself.
        expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[?2031h')
      } finally {
        vi.useRealTimers()
      }

      binding.dispose()
    })

    // Fish toggles 2031 every prompt; never answer subscriptions, but track each chunk for theme flips even when xterm batches away the toggles (#9993).
  })
}
