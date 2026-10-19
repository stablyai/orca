import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

export function registerPtyConnectionUnansweredCommandFinishTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  describe('command-finished cleanup when the shell check cannot answer', () => {
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

    describe.each([
      { label: 'unanswered local read', ptyId: 'pty-omp-unanswered', fails: false },
      { label: 'failed local read', ptyId: 'pty-omp-failed', fails: true },
      { label: 'unavailable SSH host', ptyId: 'ssh:conn@@pty-omp-unavailable', fails: false }
    ])('$label', ({ ptyId, fails }) => {
      it.each(['working', 'done'] as const)(
        'keeps %s OMP status through repeated command finishes without a launch record',
        async (state) => {
          vi.useFakeTimers()
          // Import after reset so each case binds its own store and transport mocks.
          const { connectPanePty } = await import('./pty-connection')
          vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(async () => {
            if (fails) {
              throw new Error('execution host unavailable')
            }
            return null
          })
          const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
          const tabId = 'tab-omp-unanswered'
          const paneKey = makePaneKey(tabId, LEAF_1)
          const transport = createMockTransport(ptyId)
          transport.connect.mockImplementation(
            async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
              dataCallbackRef.current = callbacks.onData ?? null
              return { id: ptyId }
            }
          )
          transportFactoryQueue.push(transport)
          mockStoreState.agentStatusByPaneKey[paneKey] = {
            paneKey,
            state,
            prompt: 'worker task',
            updatedAt: 1_000,
            stateStartedAt: 900,
            agentType: 'omp',
            terminalTitle: 'OMP',
            stateHistory: []
          }
          mockStoreState.dropAgentStatus.mockImplementation((key: string) => {
            delete mockStoreState.agentStatusByPaneKey[key]
          })

          connectPanePty(
            createPane(1) as never,
            createManager(1) as never,
            createDeps({ tabId, isVisibleRef: { current: false } }) as never
          )
          await vi.advanceTimersByTimeAsync(20)
          await flushAsyncTicks()

          for (const bytes of [
            '\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07',
            '\x1b]133;D;0\x07'
          ]) {
            dataCallbackRef.current?.(bytes)
            await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
            await flushAsyncTicks()

            expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
              agentType: 'omp',
              state,
              prompt: 'worker task'
            })
            expect(window.api.agentStatus.reconcileEndedProcess).not.toHaveBeenCalled()
          }
        }
      )
    })
  })
}
