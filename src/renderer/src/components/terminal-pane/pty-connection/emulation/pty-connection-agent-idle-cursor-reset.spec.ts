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
import {
  RESET_KITTY_KEYBOARD_PROTOCOL,
  RESET_TERMINAL_CURSOR_STYLE
} from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { temporarilySetNavigatorUserAgent } from '../test-fixtures/pty-connection-test-dom'

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

export function registerPtyConnectionAgentIdleCursorResetTests(): void {
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

    it('resets renderer cursor style when an agent becomes idle', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks)
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
    })

    it('keeps kitty keyboard state when a native Windows agent becomes idle', async () => {
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks2 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      try {
        const pane = createPane(1)
        const manager = createManager(1)
        const deps = createDeps()

        connectPanePty(
          pane as never,
          manager as never,
          bindPaneAgentTitleMocks(deps as never, agentTitleMocks2)
        )

        const idleHandler = createdTransportOptions[0]?.onAgentBecameIdle as
          | ((title: string) => void)
          | undefined
        if (!idleHandler) {
          throw new Error('Expected onAgentBecameIdle to be registered')
        }

        idleHandler('* Codex done')

        // Why: a finished turn is not a dead app; its kitty flags stay until the host sees it exit.
        expect(pane.terminal.write).toHaveBeenCalledWith(
          RESET_TERMINAL_CURSOR_STYLE,
          expect.any(Function)
        )
        expect(pane.terminal.write).not.toHaveBeenCalledWith(
          `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`,
          expect.any(Function)
        )
      } finally {
        restoreUserAgent()
      }
    })
  })
}

export function registerPtyConnectionWindowsCompletedTurnCursorResetTests(): void {
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

    it('resets cursor style when native Windows hook status reaches done', async () => {
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      try {
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const pane = createPane(1)
        const manager = createManager(1)
        const deps = createDeps()

        connectPanePty(
          pane as never,
          manager as never,
          bindPaneAgentTitleMocks(deps as never, agentTitleMocks4)
        )

        mockStoreState.agentStatusByPaneKey[paneKey] = {
          state: 'working',
          prompt: 'ship it',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          agentType: 'codex',
          paneKey,
          stateHistory: []
        }
        notifyStoreSubscribers()
        expect(pane.terminal.write).not.toHaveBeenCalled()

        const doneStatus = {
          state: 'done',
          prompt: 'ship it',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          agentType: 'codex',
          paneKey,
          stateHistory: []
        }
        mockStoreState.agentStatusByPaneKey[paneKey] = doneStatus
        notifyStoreSubscribers()

        expect(pane.terminal.write).toHaveBeenCalledWith(
          RESET_TERMINAL_CURSOR_STYLE,
          expect.any(Function)
        )
      } finally {
        restoreUserAgent()
      }
    })

    it('resets cursor style when a batched done→working→done burst lands as one publication', async () => {
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      try {
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const firstDoneAt = Date.now()
        mockStoreState.agentStatusByPaneKey[paneKey] = {
          state: 'done',
          prompt: 'first turn',
          updatedAt: firstDoneAt,
          stateStartedAt: firstDoneAt,
          agentType: 'codex',
          paneKey,
          stateHistory: [{ state: 'working', prompt: 'first turn', startedAt: firstDoneAt - 5_000 }]
        }
        const pane = createPane(1)
        const manager = createManager(1)
        const deps = createDeps()

        connectPanePty(
          pane as never,
          manager as never,
          bindPaneAgentTitleMocks(deps as never, agentTitleMocks5)
        )
        expect(pane.terminal.write).not.toHaveBeenCalled()

        // Batching coalesces done→working→done; only stateHistory proves the new turn re-armed Kitty.
        const secondDoneAt = firstDoneAt + 10_000
        mockStoreState.agentStatusByPaneKey[paneKey] = {
          state: 'done',
          prompt: 'second turn',
          updatedAt: secondDoneAt,
          stateStartedAt: secondDoneAt,
          agentType: 'codex',
          paneKey,
          stateHistory: [
            { state: 'working', prompt: 'first turn', startedAt: firstDoneAt - 5_000 },
            { state: 'done', prompt: 'first turn', startedAt: firstDoneAt },
            { state: 'working', prompt: 'second turn', startedAt: secondDoneAt - 2_000 }
          ]
        }
        notifyStoreSubscribers()

        expect(pane.terminal.write).toHaveBeenCalledWith(
          RESET_TERMINAL_CURSOR_STYLE,
          expect.any(Function)
        )
      } finally {
        restoreUserAgent()
      }
    })

    it('resets cursor style when a batched burst ends on working after a completed turn', async () => {
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      try {
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const startedAt = Date.now()
        mockStoreState.agentStatusByPaneKey[paneKey] = {
          state: 'working',
          prompt: 'ship it',
          updatedAt: startedAt,
          stateStartedAt: startedAt,
          agentType: 'codex',
          paneKey,
          stateHistory: []
        }
        const pane = createPane(1)
        const manager = createManager(1)
        const deps = createDeps()

        connectPanePty(
          pane as never,
          manager as never,
          bindPaneAgentTitleMocks(deps as never, agentTitleMocks6)
        )
        notifyStoreSubscribers()
        expect(pane.terminal.write).not.toHaveBeenCalled()

        mockStoreState.agentStatusByPaneKey[paneKey] = {
          state: 'working',
          prompt: 'follow-up',
          updatedAt: startedAt + 8_000,
          stateStartedAt: startedAt + 8_000,
          agentType: 'codex',
          paneKey,
          stateHistory: [
            { state: 'working', prompt: 'ship it', startedAt },
            { state: 'done', prompt: 'ship it', startedAt: startedAt + 4_000 }
          ]
        }
        notifyStoreSubscribers()

        expect(pane.terminal.write).toHaveBeenCalledWith(
          RESET_TERMINAL_CURSOR_STYLE,
          expect.any(Function)
        )
      } finally {
        restoreUserAgent()
      }
    })

    it('keeps native Windows same-turn done repaints from re-resetting cursor style', async () => {
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks7 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      try {
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const doneAt = Date.now()
        const pane = createPane(1)
        const manager = createManager(1)
        const deps = createDeps()

        connectPanePty(
          pane as never,
          manager as never,
          bindPaneAgentTitleMocks(deps as never, agentTitleMocks7)
        )

        mockStoreState.agentStatusByPaneKey[paneKey] = {
          state: 'done',
          prompt: 'ship it',
          updatedAt: doneAt,
          stateStartedAt: doneAt,
          agentType: 'codex',
          paneKey,
          stateHistory: []
        }
        notifyStoreSubscribers()
        expect(pane.terminal.write).toHaveBeenCalledWith(
          RESET_TERMINAL_CURSOR_STYLE,
          expect.any(Function)
        )
        const writesAfterDone = (pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.length

        mockStoreState.agentStatusByPaneKey[paneKey] = {
          state: 'done',
          prompt: 'ship it',
          updatedAt: doneAt + 1_000,
          stateStartedAt: doneAt,
          agentType: 'codex',
          paneKey,
          stateHistory: []
        }
        notifyStoreSubscribers()

        expect((pane.terminal.write as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
          writesAfterDone
        )
      } finally {
        restoreUserAgent()
      }
    })
  })
}

export function registerPtyConnectionWindowsCursorResetDisposalTests(): void {
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

    it('unsubscribes the native Windows done reset watcher on pane dispose', async () => {
      const restoreUserAgent = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks12 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport()
      transportFactoryQueue.push(transport)

      try {
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const pane = createPane(1)
        const manager = createManager(1)
        const deps = createDeps()

        const binding = connectPanePty(
          pane as never,
          manager as never,
          bindPaneAgentTitleMocks(deps as never, agentTitleMocks12)
        )
        binding.dispose()
        pane.terminal.write.mockClear()

        mockStoreState.agentStatusByPaneKey[paneKey] = {
          state: 'done',
          prompt: 'ship it',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          agentType: 'codex',
          paneKey,
          stateHistory: []
        }
        notifyStoreSubscribers()

        expect(pane.terminal.write).not.toHaveBeenCalled()
      } finally {
        restoreUserAgent()
      }
    })
  })
}
