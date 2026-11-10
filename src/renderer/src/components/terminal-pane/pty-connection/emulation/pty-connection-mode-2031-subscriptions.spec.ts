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

export function registerPtyConnectionMode2031SubscriptionsTests(): void {
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

    describe('mode 2031 subscriptions are tracked per raw PTY chunk, never answered', () => {
      async function connectVisiblePane(): Promise<{
        transport: ReturnType<typeof createMockTransport>
        deps: ReturnType<typeof createDeps>
        emit: (data: string, meta?: { droppedOutput?: boolean }) => void
        reconnect: () => void
        dispose: () => void
      }> {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
        const transport = createMockTransport('pty-id')
        const captured: {
          current: ((data: string, meta?: { droppedOutput?: boolean }) => void) | null
          onConnect?: () => void
        } = { current: null }
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            captured.current = callbacks.onData ?? null
            captured.onConnect = callbacks.onConnect
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
        const deps = createDeps({ isVisibleRef: { current: true } })
        const binding = connectPanePty(
          pane as never,
          manager as never,
          bindPaneAgentTitleMocks(deps as never, agentTitleMocks)
        )
        await flushAsyncTicks(6)
        return {
          transport,
          deps,
          emit: (data: string, meta?: { droppedOutput?: boolean }) =>
            captured.current?.(data, meta),
          reconnect: () => captured.onConnect?.(),
          dispose: () => binding.dispose()
        }
      }

      const replies = (transport: { sendInput: { mock: { calls: unknown[][] } } }): unknown[] =>
        transport.sendInput.mock.calls.flat().filter((arg) => String(arg).includes('997'))

      it('catches a subscribed pane up once per mode change across repeated reconnects', async () => {
        const { transport, emit, reconnect, dispose } = await connectVisiblePane()
        emit('\x1b[?2031h')
        mockStoreState = {
          ...mockStoreState,
          settings: { ...mockStoreState.settings, theme: 'dark' }
        }
        reconnect()
        reconnect()
        mockStoreState = {
          ...mockStoreState,
          settings: { ...mockStoreState.settings, theme: 'light' }
        }
        reconnect()
        reconnect()
        expect(replies(transport)).toEqual(['\x1b[?997;1n', '\x1b[?997;2n'])
        dispose()
      })

      it('defers to the viewer holding the grid, then catches up once on release', async () => {
        const { transport, emit, reconnect, dispose } = await connectVisiblePane()
        const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
        emit('\x1b[?2031h')
        setFitOverride('pty-id', 'mobile-fit', 40, 20)
        mockStoreState = {
          ...mockStoreState,
          settings: { ...mockStoreState.settings, theme: 'dark' }
        }
        reconnect()
        expect(replies(transport)).toEqual([])
        setFitOverride('pty-id', 'desktop-fit', 0, 0)
        setFitOverride('pty-id', 'desktop-fit', 0, 0)
        expect(replies(transport)).toEqual(['\x1b[?997;1n'])
        // A repeated DECSET while held must not cancel the owed report.
        setFitOverride('pty-id', 'mobile-fit', 40, 20)
        mockStoreState = {
          ...mockStoreState,
          settings: { ...mockStoreState.settings, theme: 'light' }
        }
        emit('\x1b[?2031h')
        setFitOverride('pty-id', 'desktop-fit', 0, 0)
        expect(replies(transport)).toEqual(['\x1b[?997;1n', '\x1b[?997;2n'])
        // The holder may have told the program something else, so release re-sends even an unchanged mode.
        setFitOverride('pty-id', 'remote-desktop-fit', 40, 20)
        setFitOverride('pty-id', 'desktop-fit', 0, 0)
        reconnect()
        expect(replies(transport)).toEqual(['\x1b[?997;1n', '\x1b[?997;2n', '\x1b[?997;2n'])
        dispose()
      })
    })
  })
}
