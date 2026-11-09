import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POST_REPLAY_DEAD_TUI_RESET,
  POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET,
  POST_REPLAY_LIVE_SNAPSHOT_RESET,
  POST_REPLAY_REATTACH_RESET
} from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { replayEpilogue } from '../test-fixtures/pty-connection-test-replay-epilogue'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_1,
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

export function registerPtyConnectionHiddenQuerySnapshotAuthorityTests(): void {
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

    it('keeps split hidden-to-visible Codex stateful queries behind snapshot restore', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks9 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'snapshot-before-cpr\r\n',
        cols: 100,
        rows: 30
      })

      const isVisibleRef = { current: false }
      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef,
              startup: { command: 'codex' }
            }),
            agentTitleMocks9
          )
        )
      )
      try {
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('\x1b[6')
        isVisibleRef.current = true
        capturedDataCallback.current?.('n')
        await flushAsyncTicks(20)

        expect(pane.terminal.write).toHaveBeenCalledWith(
          'snapshot-before-cpr\r\n',
          expect.any(Function)
        )
        expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[6n', expect.any(Function))
      } finally {
        binding.dispose()
      }
    })

    it('preserves live agent cursor and focus modes on hidden-to-visible snapshot restore', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks10 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'agent-frame\x1b[?25l',
        cols: 100,
        rows: 30,
        alternateScreen: true
      })
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const now = Date.now()
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'working',
        prompt: '',
        agentType: 'codex',
        paneKey,
        terminalTitle: 'codex',
        updatedAt: now,
        stateStartedAt: now,
        stateHistory: []
      }

      const isVisibleRef = { current: false }
      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef,
              startup: { command: 'codex' }
            }),
            agentTitleMocks10
          )
        )
      )
      try {
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('\x1b[6')
        isVisibleRef.current = true
        capturedDataCallback.current?.('n')
        await flushAsyncTicks(20)

        // A live agent owns ?1004h (focus reporting); the plain reset's ?1004l would silence focus events until restart, since agents only enable it at startup.
        expect(pane.terminal.write).toHaveBeenCalledWith(
          replayEpilogue(POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET),
          expect.any(Function)
        )
        expect(pane.terminal.write).not.toHaveBeenCalledWith(
          replayEpilogue(POST_REPLAY_LIVE_SNAPSHOT_RESET),
          expect.any(Function)
        )
        expect(pane.terminal.write).not.toHaveBeenCalledWith(
          replayEpilogue(POST_REPLAY_DEAD_TUI_RESET),
          expect.any(Function)
        )
      } finally {
        binding.dispose()
      }
    })

    it('lets fresh host shell proof outrank stale live-agent metadata on reveal', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks11 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'stale-agent-frame\x1b[?25l',
        cols: 100,
        rows: 30,
        alternateScreen: true,
        terminalOwner: 'shell'
      })
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const now = Date.now()
      mockStoreState.agentStatusByPaneKey[paneKey] = {
        state: 'working',
        prompt: '',
        agentType: 'codex',
        paneKey,
        terminalTitle: 'codex',
        updatedAt: now,
        stateStartedAt: now,
        stateHistory: []
      }

      const isVisibleRef = { current: false }
      const pane = createPane(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({ isVisibleRef, startup: { command: 'codex' } }),
            agentTitleMocks11
          )
        )
      )
      try {
        await flushAsyncTicks(6)
        capturedDataCallback.current?.('\x1b[6')
        isVisibleRef.current = true
        capturedDataCallback.current?.('n')
        await flushAsyncTicks(20)

        expect(pane.terminal.write).toHaveBeenCalledWith(
          replayEpilogue(POST_REPLAY_DEAD_TUI_RESET),
          expect.any(Function)
        )
        expect(pane.terminal.write).not.toHaveBeenCalledWith(
          replayEpilogue(POST_REPLAY_LIVE_AGENT_SNAPSHOT_RESET),
          expect.any(Function)
        )
      } finally {
        binding.dispose()
      }
    })

    it('preserves current behavior when a snapshot has no host ownership proof', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks12 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'shell-frame\x1b[?25l',
        cols: 100,
        rows: 30,
        alternateScreen: false
      })

      const isVisibleRef = { current: false }
      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef,
              startup: { command: 'codex' }
            }),
            agentTitleMocks12
          )
        )
      )
      try {
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('\x1b[6')
        isVisibleRef.current = true
        capturedDataCallback.current?.('n')
        await flushAsyncTicks(20)

        expect(pane.terminal.write).toHaveBeenCalledWith(
          replayEpilogue(POST_REPLAY_LIVE_SNAPSHOT_RESET),
          expect.any(Function)
        )
        expect(pane.terminal.write).not.toHaveBeenCalledWith(
          replayEpilogue(POST_REPLAY_REATTACH_RESET),
          expect.any(Function)
        )
        expect(pane.terminal.write).not.toHaveBeenCalledWith(
          replayEpilogue(POST_REPLAY_DEAD_TUI_RESET),
          expect.any(Function)
        )
      } finally {
        binding.dispose()
      }
    })

    it('keeps a live alternate-screen pane interactive when a legacy snapshot omits its mode flag', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks13 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'legacy-tui-frame',
        cols: 100,
        rows: 30
      })

      const isVisibleRef = { current: false }
      const pane = createPane(1)
      pane.terminal.buffer.active.type = 'alternate'
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef,
              startup: { command: 'codex' }
            }),
            agentTitleMocks13
          )
        )
      )
      try {
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('\x1b[6')
        isVisibleRef.current = true
        capturedDataCallback.current?.('n')
        await flushAsyncTicks(20)

        expect(pane.terminal.write).toHaveBeenCalledWith(
          replayEpilogue(POST_REPLAY_LIVE_SNAPSHOT_RESET),
          expect.any(Function)
        )
        expect(pane.terminal.write).not.toHaveBeenCalledWith(
          replayEpilogue(POST_REPLAY_REATTACH_RESET),
          expect.any(Function)
        )
      } finally {
        binding.dispose()
      }
    })

    it('grounds a stale alternate-screen snapshot when the host proves shell ownership', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks14 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      getMainBufferSnapshot.mockResolvedValue({
        data: 'stale-tui-frame',
        cols: 100,
        rows: 30,
        alternateScreen: true,
        terminalOwner: 'shell'
      })

      const isVisibleRef = { current: false }
      const pane = createPane(1)
      pane.terminal.buffer.active.type = 'alternate'
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({ isVisibleRef, startup: { command: 'codex' } }),
            agentTitleMocks14
          )
        )
      )
      try {
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('\x1b[6')
        isVisibleRef.current = true
        capturedDataCallback.current?.('n')
        await flushAsyncTicks(20)

        expect(pane.terminal.write).toHaveBeenCalledWith(
          replayEpilogue(POST_REPLAY_DEAD_TUI_RESET),
          expect.any(Function)
        )
        expect(pane.terminal.write).not.toHaveBeenCalledWith(
          replayEpilogue(POST_REPLAY_LIVE_SNAPSHOT_RESET),
          expect.any(Function)
        )
        expect(window.api.pty.inspectProcess).not.toHaveBeenCalled()
      } finally {
        binding.dispose()
      }
    })
  })
}
