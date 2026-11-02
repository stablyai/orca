import { bindPtyConnectionTestMocks, ptyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import { temporarilySetNavigatorUserAgent } from './pty-connection-test-dom'
import {
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

export function registerPtyConnectionRendererRiskRepaintTests(): void {
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

    it('does not switch renderers for Arabic output', async () => {
      const { connectPanePty } = await import('./pty-connection')
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
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('Arabic: السلام عليكم\r\n')

      expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
      expect(pane.terminal.write).toHaveBeenCalledWith(
        'Arabic: السلام عليكم\r\n',
        expect.any(Function)
      )
    })

    it('does not switch renderers across split background SGR PTY chunks', async () => {
      const { connectPanePty } = await import('./pty-connection')
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
      const manager = createManager(1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[4')
      capturedDataCallback.current?.('8;2;52')
      expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()

      capturedDataCallback.current?.(';52;52m codex block \x1b[0m\r\n')

      expect(manager.markPaneHasComplexScriptOutput).not.toHaveBeenCalled()
    })

    it('forces a viewport refresh for foreground CJK output without CSI', async () => {
      const { connectPanePty } = await import('./pty-connection')
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

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('没改什么(护城河)\r\n')

      expect(refresh).toHaveBeenCalledWith(0, 39, true)
    })

    it('refreshes renderer-risk output without clearing the shared glyph atlas', async () => {
      const { connectPanePty } = await import('./pty-connection')
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
      let parseCallback: (() => void) | undefined
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
        parseCallback = callback
      })

      connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('没改什么(护城河)\r\n')
      expect(refresh).not.toHaveBeenCalled()
      parseCallback?.()
      expect(refresh).toHaveBeenCalledWith(0, 39, true)
      expectNoGlobalAtlasRecovery()
    })

    it('refreshes alternate-screen redraws without clearing the shared glyph atlas', async () => {
      const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
      try {
        const { connectPanePty } = await import('./pty-connection')
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
        ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
        const refresh = vi.fn()
        let parseCallback: (() => void) | undefined
        const terminal = pane.terminal as typeof pane.terminal & {
          _core?: { refresh: typeof refresh }
        }
        terminal._core = { refresh }
        terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
          parseCallback = callback
        })

        connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
        await flushAsyncTicks(6)

        capturedDataCallback.current?.(
          '\x1b[2J\x1b[H{"name":"eepo"}\r\n\x1b[2;1H{"name":"expo"}\x1b[K'
        )
        parseCallback?.()
        expect(refresh).toHaveBeenCalledWith(0, 39, true)
        expectNoGlobalAtlasRecovery()
      } finally {
        restoreNavigator()
      }
    })

    it('refreshes a foreground rewrite entering alternate screen without an atlas clear', async () => {
      const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
      try {
        const { connectPanePty } = await import('./pty-connection')
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
        let parseCallback: (() => void) | undefined
        const terminal = pane.terminal as typeof pane.terminal & {
          _core?: { refresh: typeof refresh }
        }
        terminal._core = { refresh }
        terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
          parseCallback = callback
        })

        connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('\x1b[?1049h\x1b[2J\x1b[HVim package.json')
        // Why: xterm switches to the alternate buffer while parsing; the write callback observes the post-parse state.
        ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
        parseCallback?.()
        expect(refresh).toHaveBeenCalledWith(0, 39, true)
        expectNoGlobalAtlasRecovery()
      } finally {
        restoreNavigator()
      }
    })

    it('avoids atlas clears when alternate-screen entry splits across chunks', async () => {
      const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
      try {
        const { connectPanePty } = await import('./pty-connection')
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
        let parseCallback: (() => void) | undefined
        const terminal = pane.terminal as typeof pane.terminal & {
          _core?: { refresh: typeof refresh }
        }
        terminal._core = { refresh }
        terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
          parseCallback = callback
        })

        connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
        await flushAsyncTicks(6)

        // Why: PTY reads split CSI sequences at arbitrary byte boundaries, so the enter sequence can straddle two onData chunks.
        capturedDataCallback.current?.('\x1b[?104')
        parseCallback?.()

        capturedDataCallback.current?.('9h\x1b[2J\x1b[H~\x1b[K')
        ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
        parseCallback?.()
        expect(refresh).toHaveBeenCalledWith(0, 39, true)
        expectNoGlobalAtlasRecovery()
      } finally {
        restoreNavigator()
      }
    })

    it('avoids atlas clears when a foreground rewrite leaves alternate screen', async () => {
      const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
      try {
        const { connectPanePty } = await import('./pty-connection')
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
        ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
        const refresh = vi.fn()
        let parseCallback: (() => void) | undefined
        const terminal = pane.terminal as typeof pane.terminal & {
          _core?: { refresh: typeof refresh }
        }
        terminal._core = { refresh }
        terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
          parseCallback = callback
        })

        connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('\x1b[34;1H\x1b[K\x1b[34;1H\x1b[?1049l\x1b[?25h')
        ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'normal'
        parseCallback?.()
        expect(refresh).toHaveBeenCalledWith(0, 39, true)
        expectNoGlobalAtlasRecovery()
      } finally {
        restoreNavigator()
      }
    })

    it('avoids atlas clears when one chunk enters and exits alternate screen', async () => {
      const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
      try {
        const { connectPanePty } = await import('./pty-connection')
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
        let parseCallback: (() => void) | undefined
        const terminal = pane.terminal as typeof pane.terminal & {
          _core?: { refresh: typeof refresh }
        }
        terminal._core = { refresh }
        terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
          parseCallback = callback
        })

        connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('\x1b[?1049h\x1b[2J\x1b[Hpager frame\x1b[K\x1b[?1049l')
        parseCallback?.()
        expect(refresh).toHaveBeenCalledWith(0, 39, true)
        expectNoGlobalAtlasRecovery()
      } finally {
        restoreNavigator()
      }
    })

    it('avoids atlas clears for captured redraw chunks split mid-sequence', async () => {
      const restoreNavigator = temporarilySetNavigatorUserAgent('Mozilla/5.0 (Macintosh)')
      try {
        const { connectPanePty } = await import('./pty-connection')
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
        ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
        const refresh = vi.fn()
        let parseCallback: (() => void) | undefined
        const terminal = pane.terminal as typeof pane.terminal & {
          _core?: { refresh: typeof refresh }
        }
        terminal._core = { refresh }
        terminal.write = vi.fn((_data: string | Uint8Array, callback?: () => void) => {
          parseCallback = callback
        })

        connectPanePty(pane as never, createManager(1) as never, createDeps() as never)
        await flushAsyncTicks(6)

        // Captured from a real vim session: a 1024-byte PTY read boundary cuts the cursor move \x1b[30;5H into "\x1b[30" + ";5H".
        capturedDataCallback.current?.('"rules": {\x1b[29;15H\x1b[K\x1b[30')
        parseCallback?.()

        capturedDataCallback.current?.(
          ';5H  "js-combine-iterations": "off"\r\n    }\x1b[31;6H\x1b[K\x1b[33;1H\x1b[?25h'
        )
        parseCallback?.()
        expect(refresh).toHaveBeenCalled()
        expectNoGlobalAtlasRecovery()
      } finally {
        restoreNavigator()
      }
    })
  })
}
