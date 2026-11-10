import { registerStaleDaemonSnapshotReplayTests } from './pty-connection-stale-daemon-snapshot-replay.spec'
import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  RESET_GRAPHIC_RENDITION,
  RELEASE_SYNCHRONIZED_OUTPUT
} from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { replayEpilogue } from '../test-fixtures/pty-connection-test-replay-epilogue'
import { Terminal } from '@xterm/headless'
import { flushAsyncTicks, writeHeadlessTerminal } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks as AgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'

export function registerPtyConnectionDaemonSnapshotReplayTests(): void {
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

    it('clears the captured pen for a normal-buffer fallback reattach', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks = await vi.importMock<AgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('tab-pty')
      const snapshot = 'ORCA-SGR-REPRO \x1b[1mBOLD-RUN-LEFT-OPEN\x1b[1;34H'
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        if (sessionId) {
          return { id: sessionId, snapshot }
        }
        return null
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }]
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

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks)
      )
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RELEASE_SYNCHRONIZED_OUTPUT}${RESET_GRAPHIC_RENDITION}\x1b[2J\x1b[3J\x1b[H`,
        expect.any(Function)
      )
      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_GRAPHIC_RENDITION}${snapshot}`,
        expect.any(Function)
      )
      expect(pane.terminal.write).toHaveBeenCalledWith(
        replayEpilogue(POST_REPLAY_REATTACH_RESET),
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        replayEpilogue(POST_REPLAY_MODE_RESET, 0),
        expect.any(Function)
      )

      const rendered = new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
      try {
        await writeHeadlessTerminal(rendered, '\x1b[1;44mDIRTY')
        for (const [data] of pane.terminal.write.mock.calls) {
          if (data) {
            await writeHeadlessTerminal(rendered, data)
          }
        }
        await writeHeadlessTerminal(rendered, 'PLAIN')
        const line = rendered.buffer.active.getLine(rendered.buffer.active.baseY)
        const plainColumn = line?.translateToString(true).indexOf('PLAIN') ?? -1

        expect(line?.getCell(plainColumn)?.isBold()).toBe(0)
        expect(line?.getCell(plainColumn)?.getFgColor()).toBe(-1)
        expect(line?.getCell(plainColumn)?.getBgColor()).toBe(-1)
        expect(rendered.buffer.active.getLine(5)?.getCell(39)?.getBgColor()).toBe(-1)
      } finally {
        rendered.dispose()
      }
    })

    it('waits for a recovered destination fit before forwarding its grid or live output', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks9 = await vi.importMock<AgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const { safeFit } = await import('@/lib/pane-manager/pane-tree-ops')
      const transport = createMockTransport('tab-pty')
      let deliverLiveData = (_data: string): void => {}
      transport.connect.mockImplementation(
        async ({ sessionId, callbacks }: { sessionId?: string; callbacks?: ConnectCallbacks }) => {
          if (callbacks?.onData) {
            deliverLiveData = callbacks.onData
          }
          return sessionId
            ? {
                id: sessionId,
                snapshot: 'source-grid snapshot',
                snapshotCols: 80,
                snapshotRows: 24
              }
            : null
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
      } as StoreState
      const pane = createPane(1)
      pane.fitAddon.proposeDimensions = vi.fn(() => undefined) as never
      const { parseCallbacks, writes } = captureCallbackTerminalWrites(pane)
      const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' }
      })

      connectPanePty(
        pane as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks9)
      )
      await flushAsyncTicks(20)
      transport.resize.mockClear()
      signalPty.mockClear()
      while (parseCallbacks.length > 0) {
        parseCallbacks.shift()?.()
        await flushAsyncTicks(2)
      }
      await flushAsyncTicks(8)

      expect(transport.resize).not.toHaveBeenCalled()
      expect(signalPty).not.toHaveBeenCalledWith('tab-pty', 'SIGWINCH')

      deliverLiveData('live-after-snapshot')
      await flushAsyncTicks(4)
      expect(writes.join('')).not.toContain('live-after-snapshot')

      pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 })) as never
      safeFit(pane as never)
      await flushAsyncTicks(12)

      expect(transport.resize).toHaveBeenCalledWith(120, 40)
      expect(signalPty).toHaveBeenCalledWith('tab-pty', 'SIGWINCH')
      expect(writes.join('')).toContain('live-after-snapshot')
    })

    it('suppresses the deferred reattach grid push when mobile claims the PTY while hidden', async () => {
      // Recheck mobile takeover after the hidden pane gains a box; direct transport.resize bypasses the usual suppression.
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks11 = await vi.importMock<AgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const { safeFit } = await import('@/lib/pane-manager/pane-tree-ops')
      const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
      const transport = createMockTransport('tab-pty')
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) =>
        sessionId
          ? {
              id: sessionId,
              snapshot: 'source-grid snapshot',
              snapshotCols: 80,
              snapshotRows: 24
            }
          : null
      )
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty' }] }
      } as StoreState
      const pane = createPane(1)
      let xtermContainerDisplay = 'none'
      const xtermContainer = new EventTarget() as HTMLElement
      Object.defineProperty(xtermContainer, 'parentElement', { value: null })
      Object.defineProperty(xtermContainer, 'ownerDocument', {
        value: { defaultView: { getComputedStyle: () => ({ display: xtermContainerDisplay }) } }
      })
      ;(pane as { xtermContainer?: HTMLElement }).xtermContainer = xtermContainer
      pane.fitAddon.proposeDimensions = vi.fn(() => undefined) as never
      const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'tab-pty' },
        isVisibleRef: { current: false }
      })

      connectPanePty(
        pane as never,
        createManager(1) as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks11)
      )
      await flushAsyncTicks(20)
      transport.resize.mockClear()
      signalPty.mockClear()

      try {
        // Mobile takes the PTY while the pane is still hidden.
        setFitOverride('tab-pty', 'mobile-fit', 49, 20)

        xtermContainerDisplay = 'block'
        ;(deps.isVisibleRef as { current: boolean }).current = true
        pane.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 120, rows: 40 })) as never
        safeFit(pane as never)
        await flushAsyncTicks(12)

        expect(transport.resize).not.toHaveBeenCalledWith(120, 40)
        expect(signalPty).not.toHaveBeenCalledWith('tab-pty', 'SIGWINCH')
      } finally {
        setFitOverride('tab-pty', 'desktop-fit', 0, 0)
      }
    })

    registerStaleDaemonSnapshotReplayTests(() => ({ transportFactoryQueue, createDeps }))
  })
}
