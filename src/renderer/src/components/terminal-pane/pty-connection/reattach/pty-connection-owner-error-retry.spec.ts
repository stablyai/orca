import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { sendTerminalInputThroughPane } from '../test-fixtures/pty-connection-test-dom'
import {
  LEAF_2,
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

export function registerPtyConnectionOwnerErrorRetryTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  function seedPaneLayout(ptyId: string | null) {
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId }] },
      ptyIdsByTabId: { 'tab-1': ptyId ? [ptyId] : [] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_2 },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: ptyId ? { [LEAF_2]: ptyId } : {}
        }
      }
    }
  }

  function seedUnverifiableRestoredPane() {
    seedPaneLayout('unverifiable-pty')
    return createDeps({
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: 'unverifiable-pty' }
    })
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

    it('preserves an owner-unverified restored pane after an empty reattach result', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks13 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport()
      transport.connect.mockImplementation(async (opts: { callbacks?: ConnectCallbacks }) => {
        opts.callbacks?.onError?.('terminal_pane_owner_unverified')
        return undefined
      })
      transportFactoryQueue.push(transport)
      const deps = seedUnverifiableRestoredPane()

      connectPanePty(
        ...mockPanePtyArgs(
          createPane(2),
          createManager(2),
          bindPaneAgentTitleMocks(deps, agentTitleMocks13)
        )
      )
      await flushAsyncTicks()

      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(2, 'terminal_pane_owner_unverified')
      expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
      expect(mockStoreState.tabsByWorktree['wt-1'][0]?.ptyId).toBe('unverifiable-pty')
      expect(mockStoreState.ptyIdsByTabId?.['tab-1']).toEqual(['unverifiable-pty'])
      expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId).toEqual({
        [LEAF_2]: 'unverifiable-pty'
      })
      expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(expect.any(String), 1)
    })

    it('preserves an owner-unverified restored pane after a rejected reattach', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks14 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport()
      transport.connect.mockRejectedValueOnce(new Error('terminal_pane_owner_unverified'))
      transportFactoryQueue.push(transport)
      const deps = seedUnverifiableRestoredPane()

      connectPanePty(
        ...mockPanePtyArgs(
          createPane(2),
          createManager(2),
          bindPaneAgentTitleMocks(deps, agentTitleMocks14)
        )
      )
      await flushAsyncTicks()

      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(2, 'terminal_pane_owner_unverified')
      expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
      expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId).toEqual({
        [LEAF_2]: 'unverifiable-pty'
      })
      expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(expect.any(String), 1)
    })

    it('keeps a pane through transient history-unavailable and Retry reattaches the same ID', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport()
      transport.connect.mockImplementation(async (opts: { callbacks?: ConnectCallbacks }) => {
        opts.callbacks?.onError?.('terminal_history_unavailable')
        return undefined
      })
      transportFactoryQueue.push(transport)
      const deps = seedUnverifiableRestoredPane()

      connectPanePty(
        ...mockPanePtyArgs(
          createPane(2),
          createManager(2),
          bindPaneAgentTitleMocks(deps, agentTitleMocks)
        )
      )
      await flushAsyncTicks()

      expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(deps.clearTabPtyId).not.toHaveBeenCalled()
      transport.connect.mockImplementation(async ({ callbacks }) => {
        callbacks?.onConnect?.()
        return { id: 'unverifiable-pty', isReattach: true }
      })
      expect(transport.retryRecovery?.()).toBe(true)
      await flushAsyncTicks()
      expect(transport.connect).toHaveBeenCalledTimes(2)
      expect(transport.connect.mock.calls[1]?.[0]).toMatchObject({ sessionId: 'unverifiable-pty' })
      expect(transport.connect.mock.calls[1]?.[0].command).toBeUndefined()
      expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId).toEqual({
        [LEAF_2]: 'unverifiable-pty'
      })
    })

    // R1: a fresh start refused before it began offers Retry, which starts the same pane fresh.
    it('starts a refused fresh pane on Retry and delivers its input', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport()
      transport.connect.mockImplementation(async (opts: { callbacks?: ConnectCallbacks }) => {
        opts.callbacks?.onError?.('terminal_history_unavailable')
        return undefined
      })
      transportFactoryQueue.push(transport)
      seedPaneLayout(null)
      const deps = createDeps()
      const pane = createPane(2)

      connectPanePty(
        ...mockPanePtyArgs(pane, createManager(2), bindPaneAgentTitleMocks(deps, agentTitleMocks))
      )
      await flushAsyncTicks()

      expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(
        2,
        'terminal_history_unavailable_before_start'
      )
      expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalled()
      transport.connect.mockImplementation(async ({ callbacks }) => {
        transport.getPtyId.mockReturnValue('fresh-pty')
        callbacks?.onConnect?.()
        return { id: 'fresh-pty' }
      })
      // The refused start settles through several turns before it arms Retry.
      await vi.waitFor(() => expect(transport.retryRecovery?.()).toBe(true))
      await flushAsyncTicks()

      expect(transport.connect).toHaveBeenCalledTimes(2)
      expect(transport.connect.mock.calls[1]?.[0].sessionId).toBeUndefined()
      expect(createdTransportOptions).toHaveLength(1)
      expect(deps.onPtyErrorRef.current).toHaveBeenCalledTimes(1)
      expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId[LEAF_2]).toBe(
        'fresh-pty'
      )
      sendTerminalInputThroughPane(pane, 'typed')
      expect(transport.sendInput.mock.lastCall?.[0]).toBe('typed')
    })

    it.each([false, true])(
      'preserves an exhausted pane until explicit Retry and clears only the current owner error (fresh: %s)',
      async (fresh) => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks15 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
        const transport = createMockTransport()
        transport.connect.mockImplementation(async (opts: { callbacks?: ConnectCallbacks }) => {
          opts.callbacks?.onError?.('terminal_pane_owner_changed')
          return undefined
        })
        transportFactoryQueue.push(transport)
        const deps = fresh ? createDeps() : seedUnverifiableRestoredPane()
        const cleared = vi.fn()
        deps.onPtyErrorClearedRef = { current: cleared }

        connectPanePty(
          ...mockPanePtyArgs(
            createPane(2),
            createManager(2),
            bindPaneAgentTitleMocks(deps, agentTitleMocks15)
          )
        )
        await flushAsyncTicks()

        expect(transport.connect).toHaveBeenCalledTimes(1)
        expect(deps.onPtyErrorRef.current).toHaveBeenCalledExactlyOnceWith(
          2,
          'terminal_pane_owner_changed'
        )
        expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
        expect(deps.clearTabPtyId).not.toHaveBeenCalled()
        if (!fresh) {
          expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId).toEqual({
            [LEAF_2]: 'unverifiable-pty'
          })
        }
        const stale = transport.connect.mock.calls[0]?.[0].callbacks
        transport.connect.mockImplementation(async ({ callbacks }) => {
          callbacks?.onError?.('unrelated diagnostic')
          callbacks?.onConnect?.()
          return { id: 'unverifiable-pty', isReattach: true }
        })
        expect(transport.retryRecovery?.()).toBe(true)
        await flushAsyncTicks()
        expect(transport.connect).toHaveBeenCalledTimes(2)
        expect(transport.disconnect).not.toHaveBeenCalled()
        expect(cleared).toHaveBeenCalledExactlyOnceWith(2, 'terminal_pane_owner_changed')
        stale?.onError?.('terminal_pane_owner_changed')
        expect(
          deps.onPtyErrorRef.current.mock.calls.filter(
            ([, message]) => message === 'terminal_pane_owner_changed'
          )
        ).toHaveLength(1)
      }
    )
  })
}
