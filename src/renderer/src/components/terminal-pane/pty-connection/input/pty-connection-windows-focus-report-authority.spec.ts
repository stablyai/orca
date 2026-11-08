import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESET_TERMINAL_CURSOR_STYLE } from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import {
  temporarilySetNavigatorUserAgent,
  sendTerminalInputThroughPane
} from '../test-fixtures/pty-connection-test-dom'

import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  loadFreshTerminalModules,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'

export function registerPtyConnectionRemoteWindowsFocusReportTests(): void {
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

    it.each([
      {
        name: 'WSL',
        configure: (): void => {
          mockStoreState.tabsByWorktree = {
            'wt-1': [{ id: 'tab-1', ptyId: null, shellOverride: 'wsl.exe' }]
          }
        }
      },
      {
        name: 'remote runtime',
        configure: (): void => {
          mockStoreState.repos = [
            {
              id: 'repo1',
              connectionId: null,
              displayName: 'orca',
              executionHostId: 'runtime:owner-runtime'
            }
          ]
        }
      }
    ])(
      'keeps $name focus reports and idle reset remote-safe on Windows clients',
      async ({ configure }) => {
        const restoreUserAgent = temporarilySetNavigatorUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        )
        await loadFreshTerminalModules()
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks3 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)

        try {
          configure()
          const pane = createPane(1)
          connectPanePty(
            pane as never,
            createManager(1) as never,
            bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks3)
          )

          const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
            | ((title: string) => void)
            | undefined
          if (!idleHandler) {
            throw new Error('Expected onAgentBecameIdle to be registered')
          }
          idleHandler('* Codex done')

          expect(pane.terminal.write).toHaveBeenCalledWith(
            RESET_TERMINAL_CURSOR_STYLE,
            expect.any(Function)
          )
          transport.sendInput.mockClear()
          sendTerminalInputThroughPane(pane, '\x1b[I')
          expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I', 'query-reply')
        } finally {
          restoreUserAgent()
        }
      }
    )
  })
}

export function registerPtyConnectionWindowsFocusReportAuthorityTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  function notifyStoreSubscribers(): void {
    for (const listener of storeSubscribers.slice()) {
      listener(mockStoreState)
    }
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

    it('drops native Windows Codex focus reports while a history resume is idle', async () => {
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks8 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      try {
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const pane = createPane(1)
        pane.terminal.modes.sendFocusMode = true

        connectPanePty(
          pane as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(
            createDeps({
              startup: {
                command: "codex 'resume' 'codex-session-1'",
                launchAgent: 'codex',
                telemetry: {
                  agent_kind: 'codex',
                  launch_source: 'sidebar',
                  request_kind: 'resume'
                }
              }
            }) as never,
            agentTitleMocks8
          )
        )

        expect(mockStoreState.agentStatusByPaneKey[paneKey]).toBeUndefined()
        transport.sendInput.mockClear()

        sendTerminalInputThroughPane(pane, '\x1b[O')
        sendTerminalInputThroughPane(pane, '\x1b[I')
        expect(transport.sendInput).not.toHaveBeenCalled()

        mockStoreState.agentStatusByPaneKey[paneKey] = {
          state: 'working',
          prompt: 'continue the resumed session',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          agentType: 'codex',
          paneKey,
          stateHistory: []
        }
        notifyStoreSubscribers()

        sendTerminalInputThroughPane(pane, '\x1b[I')
        expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I', 'query-reply')
      } finally {
        restoreUserAgent()
      }
    })

    it.each([
      {
        name: 'Claude history resume',
        launchAgent: 'claude',
        agentKind: 'claude',
        requestKind: 'resume'
      },
      {
        name: 'fresh Codex launch',
        launchAgent: 'codex',
        agentKind: 'codex',
        requestKind: 'new'
      }
    ])(
      'keeps focus reports enabled for a native Windows $name',
      async ({ launchAgent, agentKind, requestKind }) => {
        const restoreUserAgent = temporarilySetNavigatorUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        )
        await loadFreshTerminalModules()
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks9 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)

        try {
          const pane = createPane(1)
          pane.terminal.modes.sendFocusMode = true

          connectPanePty(
            pane as never,
            createManager(1) as never,
            bindPaneAgentTitleMocks(
              createDeps({
                startup: {
                  command: `${launchAgent} session-command`,
                  launchAgent,
                  telemetry: {
                    agent_kind: agentKind,
                    launch_source: 'sidebar',
                    request_kind: requestKind
                  }
                }
              }) as never,
              agentTitleMocks9
            )
          )

          transport.sendInput.mockClear()
          sendTerminalInputThroughPane(pane, '\x1b[O')
          sendTerminalInputThroughPane(pane, '\x1b[I')

          expect(transport.sendInput).toHaveBeenNthCalledWith(1, '\x1b[O', 'query-reply')
          expect(transport.sendInput).toHaveBeenNthCalledWith(2, '\x1b[I', 'query-reply')
        } finally {
          restoreUserAgent()
        }
      }
    )

    it('drops only focus reports while native Windows Codex is done and resumes them when working', async () => {
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks10 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      try {
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const pane = createPane(1)
        pane.terminal.modes.sendFocusMode = true
        const doneStatus = {
          state: 'done',
          prompt: 'ship it',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          agentType: 'codex',
          paneKey,
          stateHistory: []
        }

        connectPanePty(
          pane as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks10)
        )

        mockStoreState.agentStatusByPaneKey[paneKey] = doneStatus
        notifyStoreSubscribers()
        const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
          | ((title: string) => void)
          | undefined
        idleHandler?.('* Codex done')
        transport.sendInput.mockClear()

        sendTerminalInputThroughPane(pane, '\x1b[O')
        sendTerminalInputThroughPane(pane, '\x1b[I')
        expect(transport.sendInput).not.toHaveBeenCalled()

        sendTerminalInputThroughPane(pane, '\x7f')
        sendTerminalInputThroughPane(pane, 'x')
        expect(transport.sendInput).toHaveBeenNthCalledWith(1, '\x7f', 'query-reply')
        expect(transport.sendInput).toHaveBeenNthCalledWith(2, 'x', 'query-reply')
        expect(pane.terminal.modes.sendFocusMode).toBe(true)

        mockStoreState.agentStatusByPaneKey[paneKey] = {
          ...doneStatus,
          state: 'working'
        }
        notifyStoreSubscribers()
        transport.sendInput.mockClear()

        sendTerminalInputThroughPane(pane, '\x1b[I')
        expect(transport.sendInput).toHaveBeenCalledWith('\x1b[I', 'query-reply')
        expect(pane.terminal.modes.sendFocusMode).toBe(true)

        mockStoreState.agentStatusByPaneKey[paneKey] = {
          ...doneStatus,
          state: 'waiting'
        }
        notifyStoreSubscribers()
        transport.sendInput.mockClear()
        sendTerminalInputThroughPane(pane, '\x1b[O')
        expect(transport.sendInput).toHaveBeenCalledWith('\x1b[O', 'query-reply')
      } finally {
        restoreUserAgent()
      }
    })

    it('keeps focus reports enabled for native Windows Cursor completion', async () => {
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks11 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      try {
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const pane = createPane(1)
        pane.terminal.modes.sendFocusMode = true

        connectPanePty(
          pane as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks11)
        )

        mockStoreState.agentStatusByPaneKey[paneKey] = {
          state: 'done',
          prompt: 'ship it',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          agentType: 'cursor',
          paneKey,
          stateHistory: []
        }
        notifyStoreSubscribers()
        transport.sendInput.mockClear()

        sendTerminalInputThroughPane(pane, '\x1b[O')
        sendTerminalInputThroughPane(pane, '\x1b[I')

        expect(transport.sendInput).toHaveBeenNthCalledWith(1, '\x1b[O', 'query-reply')
        expect(transport.sendInput).toHaveBeenNthCalledWith(2, '\x1b[I', 'query-reply')
        expect(pane.terminal.modes.sendFocusMode).toBe(true)
      } finally {
        restoreUserAgent()
      }
    })
  })
}
