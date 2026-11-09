import {
  bindPtyConnectionTestMocks,
  ptyConnectionTestMocks
} from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
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

export function registerPtyConnectionHiddenOutputSchedulingTests(): void {
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

    it('keeps hidden synchronized output off the global atlas recovery path', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false }
            }),
            agentTitleMocks
          )
        )
      )
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      try {
        const startChunk = '\x1b[?2026h'
        const plainRowChunk = '| hidden Claude row |\r\n'
        const endChunk = '\x1b[?2026l'

        capturedDataCallback.current?.(startChunk)
        capturedDataCallback.current?.(plainRowChunk)
        capturedDataCallback.current?.(endChunk)

        expect(writes).toEqual([])
        vi.advanceTimersByTime(50)

        expect(writes).toEqual([`${startChunk}${plainRowChunk}${endChunk}`])

        parseCallbacks[0]?.()
        expectNoGlobalAtlasRecovery()
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps split hidden synchronized output off the global atlas recovery path', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks2 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false }
            }),
            agentTitleMocks2
          )
        )
      )
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      try {
        capturedDataCallback.current?.('\x1b[?202')
        capturedDataCallback.current?.('6hbody row\r\n')
        capturedDataCallback.current?.('tail\x1b[?20')
        capturedDataCallback.current?.('26l')

        vi.advanceTimersByTime(50)

        expect(writes.join('')).toBe('\x1b[?2026hbody row\r\ntail\x1b[?2026l')

        parseCallbacks[0]?.()
        expectNoGlobalAtlasRecovery()
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not schedule hidden atlas recovery for ordinary rich text or metadata output', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const { parseCallbacks } = captureCallbackTerminalWrites(pane)

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false }
            }),
            agentTitleMocks3
          )
        )
      )
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      try {
        capturedDataCallback.current?.('plain hidden emoji 😀 and CJK 没改什么\r\n')
        capturedDataCallback.current?.('\x1b[48;2;52;52;52mcolored shell text\x1b[0m\r\n')
        capturedDataCallback.current?.('\x1b]0;hidden title\x07\x1b]133;A\x07')

        vi.advanceTimersByTime(50)
        for (const callback of parseCallbacks) {
          callback()
        }
        expectNoGlobalAtlasRecovery()
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps hidden TUI redraw output off the global atlas recovery path', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const { parseCallbacks } = captureCallbackTerminalWrites(pane)

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false }
            }),
            agentTitleMocks4
          )
        )
      )
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      try {
        capturedDataCallback.current?.('\x1b[2J\x1b[Hredrawn hidden table\x1b[K')

        vi.advanceTimersByTime(50)

        parseCallbacks[0]?.()
        expectNoGlobalAtlasRecovery()
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps hidden rewrite frames on the pane-local output path', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false }
            }),
            agentTitleMocks5
          )
        )
      )
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      try {
        capturedDataCallback.current?.('prompt rewrite\r')
        vi.advanceTimersByTime(50)
        expect(writes).toEqual(['prompt rewrite\r'])
        parseCallbacks.shift()?.()

        capturedDataCallback.current?.('\x1b[?2026hredraw frame\x1b[?2026l')
        vi.advanceTimersByTime(50)
        expect(writes).toEqual(['prompt rewrite\r', '\x1b[?2026hredraw frame\x1b[?2026l'])
        parseCallbacks.shift()?.()

        capturedDataCallback.current?.('plain after frame')
        vi.advanceTimersByTime(50)
        parseCallbacks.shift()?.()
        expectNoGlobalAtlasRecovery()
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps a background-origin alternate-screen chunk in the stream, pane-local', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 =
        await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: {
        current: ((data: string, meta?: { background?: boolean }) => void) | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-id'
        }
      )
      transportFactoryQueue.push(transport)

      const pane = createPane(1)
      const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
      const isVisibleRef = { current: false }

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef
            }),
            agentTitleMocks6
          )
        )
      )
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      try {
        capturedDataCallback.current?.('\x1b[?2026h')
        vi.advanceTimersByTime(50)
        parseCallbacks.shift()?.()
        writes.length = 0

        isVisibleRef.current = true
        ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
        capturedDataCallback.current?.('\x1b[?2026l', { background: true })
        expect(writes).toEqual([])

        isVisibleRef.current = false
        ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'normal'
        capturedDataCallback.current?.('plain after close\r\n')
        vi.advanceTimersByTime(50)
        parseCallbacks.shift()?.()

        // Dropping the close would strand xterm inside synchronized output.
        expect(writes).toEqual(['\x1b[?2026lplain after close\r\n'])
        expectNoGlobalAtlasRecovery()
      } finally {
        vi.useRealTimers()
      }
    })

    it('queues visible split-pane PTY bytes when the pane is not active', async () => {
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
      const manager = createManager(1)
      const deps = createDeps({
        isActiveRef: { current: false },
        isVisibleRef: { current: true }
      })

      connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks7))
      )
      await flushAsyncTicks(6)

      expect(capturedDataCallback.current).not.toBeNull()
      vi.useFakeTimers()
      const redraw = '\x1b[2J\x1b[Hvisible split output\r\n'
      capturedDataCallback.current?.(redraw)

      expect(pane.terminal.write).not.toHaveBeenCalledWith(redraw, expect.any(Function))
      vi.advanceTimersByTime(0)
      expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
    })

    it('queues visible ANSI redraws when only another split pane is active', async () => {
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
      const manager = {
        ...createManager(2),
        getActivePane: vi.fn(() => ({ id: 2 }))
      }
      const deps = createDeps({
        isActiveRef: { current: true },
        isVisibleRef: { current: true }
      })

      connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks8))
      )
      await flushAsyncTicks(6)

      expect(capturedDataCallback.current).not.toBeNull()
      vi.useFakeTimers()
      const redraw = '\x1b[2J\x1b[Hvisible inactive split output\r\n'
      capturedDataCallback.current?.(redraw)

      expect(pane.terminal.write).not.toHaveBeenCalledWith(redraw, expect.any(Function))
      vi.advanceTimersByTime(0)
      expect(pane.terminal.write).toHaveBeenCalledWith(redraw, expect.any(Function))
    })

    it('routes visible pane PTY bytes through the background scheduler when the document is hidden', async () => {
      ;(globalThis as { document?: Pick<Document, 'visibilityState'> }).document = {
        visibilityState: 'hidden'
      }
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
      const manager = createManager(1)
      const deps = createDeps({
        isActiveRef: { current: true },
        isVisibleRef: { current: true }
      })

      connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks9))
      )
      await flushAsyncTicks(6)

      expect(capturedDataCallback.current).not.toBeNull()
      vi.useFakeTimers()
      capturedDataCallback.current?.('backgrounded document output\r\n')

      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        'backgrounded document output\r\n',
        expect.any(Function)
      )

      vi.advanceTimersByTime(50)
      expect(pane.terminal.write).toHaveBeenCalledWith('backgrounded document output\r\n')
    })
  })
}
