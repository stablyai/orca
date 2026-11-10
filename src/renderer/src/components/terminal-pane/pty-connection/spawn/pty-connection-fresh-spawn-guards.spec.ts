import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { sendTerminalInputThroughPane } from '../test-fixtures/pty-connection-test-dom'
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

export function registerPtyConnectionFreshSpawnGuardsTests(): void {
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

    // Do not race PTY respawn into worktree deletion; main’s removal fence must not flash a raw error before unmount.
    it('skips a fresh spawn while the pane worktree is being deleted', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        deleteStateByWorktreeId: { 'wt-1': { isDeleting: true, phase: 'deleting' } }
      }
      // Use a unique tab ID to avoid pending-spawn entries from other tests and force fresh spawn.
      const deps = createDeps({ tabId: 'tab-removal-skip-spawn' })

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks3)
      )
      await flushAsyncTicks()

      expect(transport.connect).not.toHaveBeenCalled()
      expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    })

    // A racing spawn, including under a removing parent worktree, must swallow main’s removal fence instead of flashing its raw banner.
    it('swallows a worktree-removal fence error instead of surfacing it', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks8 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const { TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE } =
        await import('../../../../../../shared/worktree/removal-fence-error')
      const transport = createMockTransport()
      const capturedOnError: { current: ((message: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedOnError.current = callbacks.onError ?? null
          return 'pty-1'
        }
      )
      transportFactoryQueue.push(transport)
      const deps = createDeps({ tabId: 'tab-fence-swallow' })

      connectPanePty(
        createPane(1) as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks8)
      )
      await flushAsyncTicks()

      // Require captured onError wiring before invoking it; optional invocation could falsely pass without exercising suppression.
      expect(capturedOnError.current).toBeTypeOf('function')
      // Electron wraps the rejected ipcMain error with its own prefix; still swallowed.
      capturedOnError.current!(
        `Error invoking remote method 'pty:spawn': Error: ${TERMINAL_REMOVAL_IN_PROGRESS_MESSAGE}`
      )
      expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
    })

    it('preserves classified user input during replay while suppressing synthetic replies', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks16 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const pane = createPane(1)
      const userInputListeners = new Set<() => void>()
      Object.assign(pane.terminal, {
        _core: {
          coreService: {
            onUserInput: (listener: () => void) => {
              userInputListeners.add(listener)
              return { dispose: () => userInputListeners.delete(listener) }
            }
          }
        }
      })
      const transport = createMockTransport('ssh:ssh-1@@pty-1')
      transportFactoryQueue.push(transport)
      const deps = createDeps()
      const deferred: (() => void)[] = []
      Object.assign(deps, {
        deferPtyInput: (_paneId: number, data: string, forward: (data: string) => void) => {
          deferred.push(() => forward(data))
        }
      })
      connectPanePty(
        pane as never,
        createManager(1, 1) as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks16)
      )
      await flushAsyncTicks()
      transport.sendInput.mockClear()
      deps.replayingPanesRef.current.set(pane.id, 1)
      for (const listener of userInputListeners) {
        listener()
      }
      sendTerminalInputThroughPane(pane, 'input_under_flood\r')
      sendTerminalInputThroughPane(pane, '\x1b[?1;2c')
      // A click on replayed scrollback that still has mouse tracking armed is user input to xterm, but must not reach the shell.
      for (const listener of userInputListeners) {
        listener()
      }
      sendTerminalInputThroughPane(pane, '\x1b[<0;12;4M')
      for (const forward of deferred.splice(0)) {
        forward()
      }
      expect(transport.sendInput).toHaveBeenCalledExactlyOnceWith('input_under_flood\r', 'driving')

      // A wheel over a replayed alt-screen frame becomes cursor keys; the fresh shell must not recall history from them.
      pane.terminal.buffer.active.type = 'alternate'
      for (const listener of userInputListeners) {
        listener()
      }
      sendTerminalInputThroughPane(pane, '\x1b[B')
      for (const forward of deferred.splice(0)) {
        forward()
      }
      expect(transport.sendInput).toHaveBeenCalledExactlyOnceWith('input_under_flood\r', 'driving')

      // The same bytes on the normal buffer can only be a keyboard arrow, which survives replay.
      pane.terminal.buffer.active.type = 'normal'
      for (const listener of userInputListeners) {
        listener()
      }
      sendTerminalInputThroughPane(pane, '\x1b[B')
      for (const forward of deferred.splice(0)) {
        forward()
      }
      expect(transport.sendInput).toHaveBeenCalledTimes(2)
      expect(transport.sendInput).toHaveBeenLastCalledWith('\x1b[B', 'driving')

      deps.replayingPanesRef.current.delete(pane.id)
      for (const listener of userInputListeners) {
        listener()
      }
      sendTerminalInputThroughPane(pane, '\x1b[<0;12;4M')
      for (const forward of deferred.splice(0)) {
        forward()
      }
      expect(transport.sendInput).toHaveBeenLastCalledWith('\x1b[<0;12;4M', 'driving')
    })
  })
}
