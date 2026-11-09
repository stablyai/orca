import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
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
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

export function registerPtyConnectionHiddenCodexQueriesTests(): void {
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

    it('keeps hidden Codex redraw floods off the live xterm path', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
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

      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false },
              startup: { command: 'codex' }
            }),
            agentTitleMocks
          )
        )
      )
      await flushAsyncTicks(6)

      vi.useFakeTimers()
      try {
        const hiddenCodexRedraw = `\x1b[?2026h\x1b[2J\x1b[H${'codex redraw '.repeat(8_000)}`
        capturedDataCallback.current?.(hiddenCodexRedraw)
        vi.advanceTimersByTime(50)

        expect(pane.terminal.write).not.toHaveBeenCalledWith(hiddenCodexRedraw)
        expect(window.api.pty.getMainBufferSnapshot).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }

      binding.dispose()
    })

    it.each(['codex', 'sleep 30 && codex', 'sleep 30 && claude'])(
      'keeps hidden %s terminal query chunks on the live xterm path',
      async (command) => {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks2 = await vi.importMock<PtyConnectionAgentTitleMocks>(
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

        const pane = createPane(1)
        const manager = createManager(1)
        const binding = connectPanePty(
          ...mockPanePtyArgs(
            pane,
            manager,
            bindPaneAgentTitleMocks(
              createDeps({
                isVisibleRef: { current: false },
                startup: { command }
              }),
              agentTitleMocks2
            )
          )
        )
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('\x1b[c')

        expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))

        binding.dispose()
      }
    )

    it('keeps only coalesced hidden Codex terminal queries on the live xterm path', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 = await vi.importMock<PtyConnectionAgentTitleMocks>(
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

      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false },
              startup: { command: 'codex' }
            }),
            agentTitleMocks3
          )
        )
      )
      await flushAsyncTicks(6)

      const coalescedChunk = `\x1b[c\x1b[?2026h\x1b[2J\x1b[H${'codex redraw '.repeat(8_000)}`
      capturedDataCallback.current?.(coalescedChunk)

      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith(coalescedChunk, expect.any(Function))

      binding.dispose()
    })

    it('answers hidden OSC color queries directly inside a mixed capability-query burst', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 = await vi.importMock<PtyConnectionAgentTitleMocks>(
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

      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false },
              startup: { command: 'codex' }
            }),
            agentTitleMocks4
          )
        )
      )
      await flushAsyncTicks(6)

      const queryBurst = '\x1b[c\x1b]11;?\x1b\\\x1b[>q\x1b[14t\x1b[16t'
      const coalescedChunk = `${queryBurst}\x1b[?2026h${'codex redraw '.repeat(8_000)}`
      capturedDataCallback.current?.(coalescedChunk)

      expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
      expect(pane.terminal.write).toHaveBeenCalledWith(
        '\x1b[c\x1b[>q\x1b[14t\x1b[16t',
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(coalescedChunk, expect.any(Function))

      binding.dispose()
    })

    it('answers adjacent hidden Codex OSC color queries directly', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 = await vi.importMock<PtyConnectionAgentTitleMocks>(
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

      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false },
              startup: { command: 'codex' }
            }),
            agentTitleMocks5
          )
        )
      )
      await flushAsyncTicks(6)

      const queries = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\'
      capturedDataCallback.current?.(`${queries}startup frame\r\n`)

      expect(transport.sendInput).toHaveBeenCalledWith('\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
      expect(transport.sendInput).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
      expect(pane.terminal.write).not.toHaveBeenCalledWith(queries, expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        `${queries}startup frame\r\n`,
        expect.any(Function)
      )

      binding.dispose()
    })

    it('keeps split hidden Codex terminal queries on the live xterm path', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 = await vi.importMock<PtyConnectionAgentTitleMocks>(
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

      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false },
              startup: { command: 'codex' }
            }),
            agentTitleMocks6
          )
        )
      )
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b[')
      capturedDataCallback.current?.(`c\x1b[?2026h${'codex redraw '.repeat(8_000)}`)

      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        `c\x1b[?2026h${'codex redraw '.repeat(8_000)}`,
        expect.any(Function)
      )

      binding.dispose()
    })

    it('keeps hidden Codex terminal queries split after ESC on the live xterm path', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks7 = await vi.importMock<PtyConnectionAgentTitleMocks>(
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

      const pane = createPane(1)
      const manager = createManager(1)
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          manager,
          bindPaneAgentTitleMocks(
            createDeps({
              isVisibleRef: { current: false },
              startup: { command: 'codex' }
            }),
            agentTitleMocks7
          )
        )
      )
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('\x1b')
      capturedDataCallback.current?.(`[c\x1b[?2026h${'codex redraw '.repeat(8_000)}`)

      expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        `[c\x1b[?2026h${'codex redraw '.repeat(8_000)}`,
        expect.any(Function)
      )

      binding.dispose()
    })

    it('flushes pending hidden Codex query prefixes when the pane becomes visible', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks8 = await vi.importMock<PtyConnectionAgentTitleMocks>(
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
            agentTitleMocks8
          )
        )
      )
      try {
        await flushAsyncTicks(6)

        capturedDataCallback.current?.('\x1b')
        isVisibleRef.current = true
        capturedDataCallback.current?.('[c')

        expect(pane.terminal.write).toHaveBeenCalledWith('\x1b[c', expect.any(Function))
      } finally {
        binding.dispose()
      }
    })
  })
}
