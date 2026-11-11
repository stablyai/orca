import {
  POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
  POST_REPLAY_DEAD_TUI_RESET,
  POST_REPLAY_MODE_RESET,
  RESET_TERMINAL_CURSOR_STYLE,
  POST_REPLAY_REATTACH_RESET
} from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { replayEpilogue } from '../test-fixtures/pty-connection-test-replay-epilogue'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import {
  bindsPaneInStore,
  expectWindowStartAskedMain,
  mainStartsPaneAs,
  mainLayoutApplyTransport
} from '../test-fixtures/pty-connection-test-main-pane-start-fixtures'
import {
  withMockedDocumentActiveElement,
  configureTerminalFocusMode
} from '../test-fixtures/pty-connection-test-dom'

import {
  buildReattachPaneTitleState,
  buildActiveRuntimeEnvironmentState,
  createInitialStoreState
} from '../test-fixtures/pty-connection-test-store-fixtures'
import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'

import {
  type ConnectCallbacks,
  LEAF_1,
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

import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

export function registerPtyConnectionDaemonPendingEscapeTailTests(): void {
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
      ;(await mainLayoutApplyTransport()).reset()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('writes the daemon pendingEscapeTailAnsi after the reset on local reattach (#7329)', async () => {
      // Why: re-arm the mid-escape tail LAST, after the reattach reset whose ESC would abort it, so a live continuation completes it.
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks2 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('tab-pty')
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        if (sessionId) {
          return {
            id: sessionId,
            snapshot: 'restored snapshot',
            snapshotCols: 80,
            snapshotRows: 24,
            pendingEscapeTailAnsi: '\x1b[3'
          }
        }
        return null
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
      } as StoreState

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks2))
      )
      await flushAsyncTicks(20)

      const tailWriteCall = pane.terminal.write.mock.invocationCallOrder.find(
        (_order, index) => pane.terminal.write.mock.calls[index][0] === '\x1b[3'
      )
      const resetWriteCall = pane.terminal.write.mock.invocationCallOrder.find((_order, index) =>
        String(pane.terminal.write.mock.calls[index][0]).includes(POST_REPLAY_REATTACH_RESET)
      )
      expect(tailWriteCall).toBeDefined()
      expect(resetWriteCall).toBeDefined()
      expect(resetWriteCall as number).toBeLessThan(tailWriteCall as number)
    })
  })
}

export function registerPtyConnectionReattachModeResetTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  function setReattachPaneTitle(title: string): void {
    mockStoreState = buildReattachPaneTitleState(mockStoreState, title)
  }

  // Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
  function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
    mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, environmentId)
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
      ;(await mainLayoutApplyTransport()).reset()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('writes the onReplayData pendingEscapeTailAnsi meta last, after the replayed bytes (#7329)', async () => {
      // Why this test: the onReplayData meta pass-through had no failing test — severing it kept the suite green.
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      enableActiveRuntimeEnvironment()
      const pane = createPane(1)
      const writes: string[] = []
      pane.terminal.write = vi.fn((data: string, callback?: () => void) => {
        writes.push(data)
        callback?.()
      }) as typeof pane.terminal.write
      const transport = createMockTransport('remote:web-env-1@@pty-7329-tail')
      const replayCallback: {
        current:
          | ((
              data: string,
              meta?: { clearBeforeReplay?: boolean; pendingEscapeTailAnsi?: string }
            ) => void)
          | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          replayCallback.current = callbacks.onReplayData ?? null
          return { id: 'remote:web-env-1@@pty-7329-tail', replay: '' }
        }
      )
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks5))
      )
      await flushAsyncTicks(20)
      expect(replayCallback.current).toBeTypeOf('function')

      replayCallback.current?.('remote snapshot bytes', {
        clearBeforeReplay: false,
        pendingEscapeTailAnsi: '\x1b[3'
      })
      await flushAsyncTicks(20)

      const snapshotIndex = writes.indexOf('remote snapshot bytes')
      const tailIndex = writes.lastIndexOf('\x1b[3')
      expect(snapshotIndex).toBeGreaterThanOrEqual(0)
      expect(tailIndex).toBeGreaterThanOrEqual(0)
      expect(tailIndex).toBeGreaterThan(snapshotIndex)
      expect(writes.slice(tailIndex + 1)).toEqual([])
    })

    it('lets fresh host shell proof outrank stale live-agent metadata on reattach', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks7 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('tab-pty')
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        if (sessionId) {
          return {
            id: sessionId,
            snapshot: '\x1b[?1049h\x1b[?1003hstale agent snapshot',
            isAlternateScreen: true,
            snapshotTerminalOwner: 'shell' as const
          }
        }
        return null
      })
      transportFactoryQueue.push(transport)
      setReattachPaneTitle('Cursor Agent')

      const pane = createPane(1)
      const manager = createManager(1)
      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              restoredLeafId: LEAF_1,
              restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
            }),
            agentTitleMocks7
          )
        )
      )
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        replayEpilogue(POST_REPLAY_DEAD_TUI_RESET),
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        replayEpilogue(POST_REPLAY_LIVE_AGENT_REATTACH_RESET),
        expect.any(Function)
      )
    })

    it('applies the fresh-shell reset when a spawn is answered with a cold-restore reattach', async () => {
      // Main can adopt during apparent fresh spawn; cold-restore mode reset must survive this second entry path (#12101).
      const { connectPanePty } = await import('../connect-pane-pty')
      const transport = createMockTransport('tab-pty')
      let activePtyId = 'tab-pty'
      transport.getPtyId.mockImplementation(() => activePtyId)
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        if (sessionId === 'tab-pty') {
          throw new Error('restored session is gone')
        }
        // Main’s start adopted a durable session; answer the window’s attach with that payload.
        activePtyId = 'adopted-pty'
        return {
          id: 'adopted-pty',
          isReattach: true,
          // Leave the cursor visible so the live-agent reset equals the constant this assertion negates.
          snapshot: '\x1b[?1003h\x1b[?1006h\x1b[?2004huser@host ~ $ ',
          coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
        }
      })
      transportFactoryQueue.push(transport)
      setReattachPaneTitle('Cursor Agent')

      const pane = createPane(1)
      const textarea = {} as HTMLTextAreaElement
      configureTerminalFocusMode(pane, textarea)
      await withMockedDocumentActiveElement(textarea, async () => {
        const manager = createManager(1)
        const deps = createDeps({
          restoredLeafId: LEAF_1,
          restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
        })
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          await mainStartsPaneAs({
            ptyId: 'adopted-pty',
            bind: bindsPaneInStore(() => mockStoreState, 'tab-1', LEAF_1)
          })
        }
        const agentTitleMocks9 = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )

        connectPanePty(
          ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks9))
        )
        await flushAsyncTicks(30)

        expect(transport.connect).toHaveBeenCalledTimes(2)
        expect(transport.connect.mock.calls[0]?.[0]?.sessionId).toBe('tab-pty')
        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          // The gone session asks main to start the pane; the attach to it meets the payload.
          await expectWindowStartAskedMain(transport, `tab-1:${LEAF_1}`)
          expect(transport.connect.mock.calls[1]?.[0]).toMatchObject({
            sessionId: 'adopted-pty',
            attachOnlyView: true
          })
        } else {
          expect(transport.connect.mock.calls[1]?.[0]?.sessionId).toBeUndefined()
        }
        const writes = (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.map(
          ([data]) => data as string
        )
        const output = writes.join('')
        const snapshotIndex = output.indexOf('\x1b[?1003h\x1b[?1006h\x1b[?2004huser@host ~ $ ')
        const resetIndex = output.indexOf(replayEpilogue(POST_REPLAY_MODE_RESET, 0))
        expect(snapshotIndex).toBeGreaterThanOrEqual(0)
        expect(resetIndex).toBeGreaterThan(snapshotIndex)
        expect(writes).toContain(replayEpilogue(POST_REPLAY_MODE_RESET, 0))
        expect(writes).not.toContain(replayEpilogue(POST_REPLAY_LIVE_AGENT_REATTACH_RESET))
      })
    })

    it('resets an already-idle agent cursor again after reattach SIGWINCH repaint', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks17 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
          'performance'
        ]
      })
      const transport = createMockTransport('tab-pty')
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        if (sessionId) {
          return { id: sessionId, snapshot: 'restored idle codex snapshot' }
        }
        return null
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', title: 'Codex done' }]
        },
        runtimePaneTitlesByTabId: {
          'tab-1': { 1: 'Codex done' }
        },
        settings: {
          ...mockStoreState.settings
        }
      } as StoreState

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      const args = mockPanePtyArgs(pane, manager, deps)
      bindPaneAgentTitleMocks(args[2], agentTitleMocks17)

      const binding = connectPanePty(...args)
      await flushAsyncTicks(20)

      expect(window.api.pty.signal).toHaveBeenCalledWith('tab-pty', 'SIGWINCH')
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        RESET_TERMINAL_CURSOR_STYLE,
        expect.any(Function)
      )

      await vi.advanceTimersByTimeAsync(300)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        RESET_TERMINAL_CURSOR_STYLE,
        expect.any(Function)
      )
      binding.dispose()
    })
  })
}
