import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  temporarilySetNavigatorUserAgent,
  sendTerminalInputThroughPane
} from './pty-connection-test-dom'
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
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

export function registerPtyConnectionForegroundWritePathTests(): void {
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
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('queues visible bulk output off the synchronous xterm write path', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('pty-1')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-1'
        }
      )
      transportFactoryQueue.push(transport)

      connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()

      vi.useFakeTimers()
      capturedDataCallback.current?.('x'.repeat(16 * 1024))

      expect(pane.terminal.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(0)
      expect(pane.terminal.write).toHaveBeenCalledWith('x'.repeat(16 * 1024), expect.any(Function))
    })

    it('keeps ANSI redraws after terminal input on the immediate xterm write path', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('pty-1')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-1'
        }
      )
      transportFactoryQueue.push(transport)

      connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
      await flushAsyncTicks()
      const onDataMock = pane.terminal.onData as unknown as {
        mock: { calls: [[(data: string) => void] | []] }
      }
      const terminalInputHandler = onDataMock.mock.calls[0]?.[0]
      expect(terminalInputHandler).toBeTypeOf('function')
      terminalInputHandler?.('a')

      const redraw = `\x1b[2J\x1b[H${'codex composer redraw '.repeat(200)}`
      capturedDataCallback.current?.(redraw)

      expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
    })

    it('keeps large ANSI redraws after terminal input on the immediate xterm write path', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('pty-1')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-1'
        }
      )
      transportFactoryQueue.push(transport)

      connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
      await flushAsyncTicks()
      const onDataMock = pane.terminal.onData as unknown as {
        mock: { calls: [[(data: string) => void] | []] }
      }
      const terminalInputHandler = onDataMock.mock.calls[0]?.[0]
      expect(terminalInputHandler).toBeTypeOf('function')
      terminalInputHandler?.('a')

      const redraw = `\x1b[2J\x1b[H${'codex large composer redraw '.repeat(1_200)}`
      expect(redraw.length).toBeGreaterThan(16 * 1024)
      expect(redraw.length).toBeLessThan(128 * 1024)
      capturedDataCallback.current?.(redraw)

      expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
    })

    it('routes terminal input through deferPtyInput so the host can withhold it', async () => {
      // Regression: inlining forwardPtyInput into onData dropped this hop, silently disabling link-click mouse suppression.
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('pty-1')
      transportFactoryQueue.push(transport)
      const deferPtyInput = vi.fn()

      connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps({ deferPtyInput })))
      await flushAsyncTicks()
      sendTerminalInputThroughPane(pane, 'a')

      expect(deferPtyInput).toHaveBeenCalledWith(1, 'a', expect.any(Function))
      expect(transport.sendInput).not.toHaveBeenCalled()

      const forward = deferPtyInput.mock.calls[0]?.[2] as (data: string) => void
      forward('a')
      expect(transport.sendInput).toHaveBeenCalledWith('a', 'query-reply')
    })

    it('forwards terminal input directly when the host supplies no deferPtyInput', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('pty-1')
      transportFactoryQueue.push(transport)

      connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
      await flushAsyncTicks()
      sendTerminalInputThroughPane(pane, 'a')

      expect(transport.sendInput).toHaveBeenCalledWith('a', 'query-reply')
    })

    it('does not forward restored output mode controls to the PTY', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('pty-1')
      transportFactoryQueue.push(transport)

      connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
      await flushAsyncTicks()
      sendTerminalInputThroughPane(pane, '\x1b[?1002h\x1b[>4;2m')

      expect(transport.sendInput).not.toHaveBeenCalled()

      sendTerminalInputThroughPane(pane, '\x1b[A')

      expect(transport.sendInput).toHaveBeenCalledWith('\x1b[A', 'query-reply')
    })

    it('keeps large ANSI redraws after captured shortcut input on the immediate path', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('pty-1')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-1'
        }
      )
      transportFactoryQueue.push(transport)

      const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
      await flushAsyncTicks()
      binding.markShortcutTerminalInputSent()

      const redraw = `\x1b[2J\x1b[H${'pi composer redraw '.repeat(200)}`
      expect(redraw.length).toBeGreaterThan(2_048)
      capturedDataCallback.current?.(redraw)

      expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
    })

    it('does not let OpenTUI-style small ANSI redraw bursts monopolize foreground writes', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('pty-1')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-1'
        }
      )
      transportFactoryQueue.push(transport)

      connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()

      vi.useFakeTimers()

      const frames = Array.from({ length: 270 }, (_, index) =>
        [
          '\x1b[?2026h',
          '\x1b[?25l',
          `\x1b[2;3H\x1b[38;2;255;138;0m${index % 2 === 0 ? '#' : '*'}${'*'.repeat(7)}\x1b[0m`,
          `\x1b[2;12H\x1b[38;2;255;138;0mOpenTUI synthetic active TUI redraw ${index}\x1b[0m`,
          `\x1b[4;6H\x1b[38;2;231;237;247m${'#'.repeat(36)} ${'opentui'.repeat(48)}\x1b[0m`
        ].join('')
      )
      expect(frames.every((frame) => frame.length <= 2048 && frame.includes('\x1b['))).toBe(true)
      expect(frames.join('').length).toBeGreaterThan(128 * 1024)

      for (const frame of frames) {
        capturedDataCallback.current?.(frame)
      }

      expect(pane.terminal.write.mock.calls.length).toBeLessThan(frames.length)
      vi.advanceTimersByTime(0)
      expect(pane.terminal.write.mock.calls.length).toBeGreaterThan(0)
    })

    it('drains a post-submit synchronized frame on the fast path when its end marker arrives late', async () => {
      // Submit-opened DEC 2026 frames keep the fast ~16ms drain even when ConPTY splits their close past 150ms (STA-1041).
      const restoreNavigator = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
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
        connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
        await flushAsyncTicks(6)

        vi.useFakeTimers()
        sendTerminalInputThroughPane(pane, '\r')
        const repaintBody = 'opencode repaint '.repeat(200)
        expect(repaintBody.length).toBeGreaterThan(2048)
        capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
        // The frame body holds, then its hold-safety fallback drains it.
        vi.advanceTimersByTime(40)
        pane.terminal.write.mockClear()

        // ConPTY delivers the closing chunk well past the 150ms redraw window.
        vi.advanceTimersByTime(300)
        const endChunk = `${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?2026l`
        expect(endChunk.length).toBeGreaterThan(2048)
        capturedDataCallback.current?.(endChunk)

        vi.advanceTimersByTime(20)
        expect(pane.terminal.write).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
        restoreNavigator()
      }
    })

    it('keeps coalescing a synchronized frame end with no recent input behind the 1s fallback', async () => {
      // Only keystrokes arm the fast path; background redraws retain the full fallback to hide transient Windows cursors (STA-1041).
      const restoreNavigator = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
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
        connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
        await flushAsyncTicks(6)

        vi.useFakeTimers()
        const repaintBody = 'opencode repaint '.repeat(200)
        capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
        // Let the frame body drain via its 250ms hold-safety fallback before isolating the closing chunk.
        vi.advanceTimersByTime(300)
        pane.terminal.write.mockClear()

        const endChunk = `${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?2026l`
        capturedDataCallback.current?.(endChunk)

        vi.advanceTimersByTime(20)
        expect(pane.terminal.write).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1000)
        expect(pane.terminal.write).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
        restoreNavigator()
      }
    })

    it('clears the synchronized latch when ConPTY splits the frame end marker', async () => {
      // Split DEC 2026 closes must release the foreground latch or later output freezes until blur (#8754).
      const restoreNavigator = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
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
        connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
        await flushAsyncTicks(6)

        vi.useFakeTimers()
        const repaintBody = 'codex spinner '.repeat(200)
        capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
        vi.advanceTimersByTime(300)
        pane.terminal.write.mockClear()

        capturedDataCallback.current?.(`${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?202`)
        capturedDataCallback.current?.('6l')
        vi.advanceTimersByTime(1100)
        expect(pane.terminal.write).toHaveBeenCalled()
        pane.terminal.write.mockClear()

        capturedDataCallback.current?.('command finished\r\n')
        vi.advanceTimersByTime(20)
        expect(pane.terminal.write).toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
        restoreNavigator()
      }
    })

    it('does not leak the interactive latch across a same-chunk close+open to a stale frame', async () => {
      // Why: a same-chunk close+open re-evaluates the new frame from its own open time so it can't inherit the prior frame's fast path.
      const restoreNavigator = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
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
        connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
        await flushAsyncTicks(6)

        vi.useFakeTimers()
        // Keep the interactive frame open: the faulty !active branch only leaks when a prior frame is still active.
        sendTerminalInputThroughPane(pane, '\r')
        const repaintBody = 'opencode repaint '.repeat(200)
        expect(repaintBody.length).toBeGreaterThan(2048)
        capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
        // Move past the 400ms interactive window without closing the frame, so any new frame now classifies non-interactive.
        vi.advanceTimersByTime(500)
        pane.terminal.write.mockClear()

        // Close and reopen after the interactive window; classify the new frame from its own start time.
        capturedDataCallback.current?.(`\x1b[?2026l\x1b[?2026h${repaintBody}`)
        vi.advanceTimersByTime(40)
        pane.terminal.write.mockClear()

        const staleEndChunk = `${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?2026l`
        expect(staleEndChunk.length).toBeGreaterThan(2048)
        capturedDataCallback.current?.(staleEndChunk)

        vi.advanceTimersByTime(20)
        expect(pane.terminal.write).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1000)
        expect(pane.terminal.write).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
        restoreNavigator()
      }
    })

    it('coalesces a second synchronized frame that opens after the window with no keystroke', async () => {
      // Why: the second frame opens after the interactive window, so its start is judged independently and stays on the 1s fallback.
      const restoreNavigator = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
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
        connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps()))
        await flushAsyncTicks(6)

        vi.useFakeTimers()
        sendTerminalInputThroughPane(pane, '\r')
        const repaintBody = 'opencode repaint '.repeat(200)
        expect(repaintBody.length).toBeGreaterThan(2048)
        capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}\x1b[?2026l`)
        vi.advanceTimersByTime(40)

        // Move past the 400ms window with no further keystroke, then open frame 2.
        vi.advanceTimersByTime(500)
        capturedDataCallback.current?.(`\x1b[?2026h${repaintBody}`)
        vi.advanceTimersByTime(40)
        pane.terminal.write.mockClear()

        const secondEndChunk = `${repaintBody}\x1b[?25l\x1b[13;14H\x1b[?25h\x1b[?2026l`
        capturedDataCallback.current?.(secondEndChunk)

        vi.advanceTimersByTime(20)
        expect(pane.terminal.write).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1000)
        expect(pane.terminal.write).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
        restoreNavigator()
      }
    })
  })
}
