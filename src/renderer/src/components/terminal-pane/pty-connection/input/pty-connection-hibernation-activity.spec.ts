import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { sendTerminalInputThroughPane } from '../test-fixtures/pty-connection-test-dom'
import { mainLayoutApplyTransport } from '../test-fixtures/pty-connection-test-main-pane-start-fixtures'
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

export function registerPtyConnectionHibernationActivityTests(): void {
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
      ;(await mainLayoutApplyTransport()).reset()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('records hibernation activity from the core user-input signal, not synthetic onData replies', async () => {
      // Regression: xterm auto-replies share the onData stream with typing; recording them as input made the planner see "input after done" and never hibernate.
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks13 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()
      const pane = createPane(2)
      const userInputListeners = new Set<() => void>()
      ;(pane.terminal as unknown as { _core: unknown })._core = {
        coreService: {
          onUserInput: vi.fn((listener: () => void) => {
            userInputListeners.add(listener)
            return { dispose: () => userInputListeners.delete(listener) }
          })
        }
      }

      const binding = connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks13))
      )
      await flushAsyncTicks()
      expect(userInputListeners.size).toBeGreaterThan(0)
      ;(mockStoreState.recordTerminalInput as ReturnType<typeof vi.fn>).mockClear()

      // A focus-out report forwarded to the PTY must not count as activity.
      sendTerminalInputThroughPane(pane, '\x1b[O')
      expect(mockStoreState.recordTerminalInput).not.toHaveBeenCalled()
      // The reply still reaches the shell; only the activity recording is gated.
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[O', 'query-reply')

      // Real user input fires the core signal before onData, as xterm does; the key must reach the PTY before the store publishes activity.
      for (const listener of userInputListeners) {
        listener()
      }
      sendTerminalInputThroughPane(pane, 'x')
      expect(transport.sendInput).toHaveBeenLastCalledWith('x', 'driving')
      expect(mockStoreState.recordTerminalInput).not.toHaveBeenCalled()
      await Promise.resolve()
      expect(mockStoreState.recordTerminalInput).toHaveBeenCalledTimes(1)

      binding.dispose()
      expect(userInputListeners.size).toBe(0)
    })

    it('falls back to onData hibernation recording when the core user-input signal is unavailable', async () => {
      // If an xterm upgrade removes the internal signal, activity recording must degrade to the historical onData behavior — never to no tracking at all.
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks14 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-pane-2')
      transportFactoryQueue.push(transport)
      const manager = createManager(1)
      const deps = createDeps()
      const pane = createPane(2)

      connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks14))
      )
      await flushAsyncTicks()
      ;(mockStoreState.recordTerminalInput as ReturnType<typeof vi.fn>).mockClear()

      sendTerminalInputThroughPane(pane, 'x')
      expect(mockStoreState.recordTerminalInput).toHaveBeenCalledTimes(1)
    })
  })
}
