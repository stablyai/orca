import {
  bindPtyConnectionTestMocks,
  ptyConnectionTestMocks
} from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  temporarilySetNavigatorUserAgent,
  sendTerminalInputThroughPane
} from '../test-fixtures/pty-connection-test-dom'
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
  loadFreshTerminalModules,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'

export function registerPtyConnectionWindowsCjkRepaintTests(): void {
  const { resetAndRefreshAllTerminalWebglAtlases, scheduleTerminalWebglAtlasRecovery } =
    ptyConnectionTestMocks

  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  function expectNoGlobalAtlasRecovery(): void {
    // Why: the removed output path requested recovery 200ms before its global reset ran.
    expect(scheduleTerminalWebglAtlasRecovery).not.toHaveBeenCalled()
    expect(resetAndRefreshAllTerminalWebglAtlases).not.toHaveBeenCalled()
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

    it('does not schedule WebGL atlas recovery for plain synchronized foreground frames', async () => {
      const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
      await loadFreshTerminalModules()
      try {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks2 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const transport = createMockTransport()
        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-id'
          }
        )
        transportFactoryQueue.push(transport)

        const pane = createPane(1)
        let parseCallback: (() => void) | undefined
        pane.terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
          parseCallback = callback
        })

        connectPanePty(
          pane as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks2)
        )
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('\x1b[?2026hplain claude frame\x1b[?2026l')
        parseCallback?.()
        expectNoGlobalAtlasRecovery()
      } finally {
        restoreNavigator()
      }
    })

    it('forces a viewport refresh for native Windows CJK foreground output after terminal input', async () => {
      const restoreNavigator = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      try {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks6 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const transport = createMockTransport()
        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-id'
          }
        )
        transportFactoryQueue.push(transport)

        const pane = createPane(1)
        const refresh = vi.fn()
        const terminal = pane.terminal as typeof pane.terminal & {
          _core?: { refresh: typeof refresh }
        }
        terminal._core = { refresh }
        terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
          callback?.()
        })

        connectPanePty(
          pane as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks6)
        )
        await flushAsyncTicks(6)
        sendTerminalInputThroughPane(pane, '已经安装完成，软件已更新后重启。')

        capturedDataCallback.current?.('已经安装完成，软件已更新后重启。')

        expect(refresh).toHaveBeenCalledWith(0, 39, true)
      } finally {
        restoreNavigator()
      }
    })

    it('forces the native Windows CJK repaint path for foreground agent output without recent terminal input', async () => {
      const restoreNavigator = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      try {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks7 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const transport = createMockTransport()
        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-id'
          }
        )
        transportFactoryQueue.push(transport)

        const pane = createPane(1)
        const refresh = vi.fn()
        const terminal = pane.terminal as typeof pane.terminal & {
          _core?: { refresh: typeof refresh }
        }
        terminal._core = { refresh }
        terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
          callback?.()
        })

        connectPanePty(
          pane as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks7)
        )
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('已经安装完成，软件已更新后重启。')

        expect(refresh).toHaveBeenCalledWith(0, 39, true)
      } finally {
        restoreNavigator()
      }
    })

    it('does not force renderer-risk repaint for ordinary non-ASCII output', async () => {
      const restoreNavigator = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      try {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks8 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const transport = createMockTransport()
        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-id'
          }
        )
        transportFactoryQueue.push(transport)

        const pane = createPane(1)
        const refresh = vi.fn()
        const terminal = pane.terminal as typeof pane.terminal & {
          _core?: { refresh: typeof refresh }
        }
        terminal._core = { refresh }
        terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
          callback?.()
        })

        connectPanePty(
          pane as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks8)
        )
        await flushAsyncTicks(6)
        sendTerminalInputThroughPane(pane, 'abc 123 ✓')

        capturedDataCallback.current?.('abc 123 ✓')

        expect(refresh).not.toHaveBeenCalled()
      } finally {
        restoreNavigator()
      }
    })

    it('does not repaint ordinary non-ASCII output on non-Windows clients', async () => {
      const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
      await loadFreshTerminalModules()
      try {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks9 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const transport = createMockTransport()
        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-id'
          }
        )
        transportFactoryQueue.push(transport)

        const pane = createPane(1)
        const refresh = vi.fn()
        const terminal = pane.terminal as typeof pane.terminal & {
          _core?: { refresh: typeof refresh }
        }
        terminal._core = { refresh }
        terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
          callback?.()
        })

        connectPanePty(
          pane as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks9)
        )
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('abc 123 ✓')

        expect(refresh).not.toHaveBeenCalled()
      } finally {
        restoreNavigator()
      }
    })

    it('schedules a follow-up repaint for Claude-style in-place prompt redraws on native Windows', async () => {
      // Why: issue #5656/#5653 — native Windows ConPTY paints Claude's in-place prompt redraw one frame late; needs a follow-up next-frame repaint.
      const restoreNavigator = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      await loadFreshTerminalModules()
      try {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks10 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const transport = createMockTransport()
        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-id'
          }
        )
        transportFactoryQueue.push(transport)

        const pane = createPane(1)
        const refresh = vi.fn()
        const terminal = pane.terminal as typeof pane.terminal & {
          _core?: { refresh: typeof refresh }
        }
        terminal._core = { refresh }
        terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
          callback?.()
        })

        connectPanePty(
          pane as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks10)
        )
        await flushAsyncTicks(6)

        // User typed into the prompt; Claude redraws the input line in place.
        capturedDataCallback.current?.('\r\x1b[3Gzzzx\x1b[K')

        // One synchronous settle refresh + one follow-up next-frame refresh.
        expect(refresh).toHaveBeenCalledTimes(2)
        expect(refresh).toHaveBeenNthCalledWith(1, 0, 39, true)
        expect(refresh).toHaveBeenNthCalledWith(2, 0, 39, true)
      } finally {
        restoreNavigator()
      }
    })

    it('coalesces forced foreground refreshes when WebGL is live', async () => {
      const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
      await loadFreshTerminalModules()
      try {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks12 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const transport = createMockTransport()
        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-id'
          }
        )
        transportFactoryQueue.push(transport)

        const pane = createPane(1)
        const synchronousRefresh = vi.fn()
        const debouncedRefresh = vi.fn()
        const terminal = pane.terminal as typeof pane.terminal & {
          _core?: { refresh: typeof synchronousRefresh }
          refresh: typeof debouncedRefresh
        }
        terminal._core = { refresh: synchronousRefresh }
        terminal.refresh = debouncedRefresh
        terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => callback?.())
        const manager = createManager(1)
        manager.hasWebglRenderer.mockReturnValue(true)

        connectPanePty(
          pane as never,
          manager as never,
          bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks12)
        )
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('\r\x1b[3Gzzzx\x1b[K')

        expect(debouncedRefresh).toHaveBeenCalledWith(0, 39)
        expect(synchronousRefresh).not.toHaveBeenCalled()
      } finally {
        restoreNavigator()
      }
    })
  })
}
