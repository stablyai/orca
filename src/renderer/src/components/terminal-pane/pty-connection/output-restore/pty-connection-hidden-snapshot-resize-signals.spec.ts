import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks, createDeferred } from '../test-fixtures/pty-connection-test-async'
import {
  captureCallbackTerminalWrites,
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

export function registerPtyConnectionHiddenSnapshotResizeSignalsTests(): void {
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

    it('keeps recovery pending when hidden output arrives during an in-flight snapshot', async () => {
      let visibilityState: DocumentVisibilityState = 'visible'
      // Fire-all like a real event target: both the pane resync and stale-visibility trust handlers listen for visibilitychange.
      const visibilityChangeListeners: (() => void)[] = []
      const visibilityChangeHandler = {
        current: (): void => {
          for (const listener of visibilityChangeListeners) {
            listener()
          }
        }
      }
      ;(globalThis as { document?: Document }).document = {
        get visibilityState() {
          return visibilityState
        },
        addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
          if (type === 'visibilitychange') {
            visibilityChangeListeners.push(listener as () => void)
          }
        }),
        removeEventListener: vi.fn()
      } as unknown as Document

      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: {
        current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
      } = { current: null }
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
      const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
      const firstSnapshot = createDeferred<{
        data: string
        cols: number
        rows: number
        seq: number
      }>()
      const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
      const visibleLive = 'visible-before-hide\r\n'
      const hiddenAgain = 'hidden-during-restore\r\n'
      getMainBufferSnapshot.mockReturnValueOnce(firstSnapshot.promise).mockResolvedValueOnce({
        data: 'snapshot-after-hidden-again\r\n',
        cols: 120,
        rows: 40,
        seq: hidden.length + visibleLive.length + hiddenAgain.length
      })

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: false }
      })
      const disposable = connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks)
      )
      await flushAsyncTicks(6)

      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      visibilityState = 'visible'
      capturedDataCallback.current?.(visibleLive, {
        seq: hidden.length + visibleLive.length,
        rawLength: visibleLive.length
      })
      await flushAsyncTicks(2)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
      ;(deps.isVisibleRef as { current: boolean }).current = false
      visibilityState = 'hidden'
      capturedDataCallback.current?.(hiddenAgain, {
        seq: hidden.length + visibleLive.length + hiddenAgain.length,
        rawLength: hiddenAgain.length
      })
      transport.resize.mockClear()
      signalPty.mockClear()
      firstSnapshot.resolve({
        data: 'snapshot-before-hidden-again\r\n',
        cols: 100,
        rows: 30,
        seq: hidden.length + visibleLive.length
      })
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
      expect(pane.terminal.write).toHaveBeenCalledWith(
        'snapshot-before-hidden-again\r\n',
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(hiddenAgain, expect.any(Function))
      expect(transport.resize).not.toHaveBeenCalled()
      expect(signalPty).not.toHaveBeenCalledWith('pty-id', 'SIGWINCH')
      ;(deps.isVisibleRef as { current: boolean }).current = true
      visibilityState = 'visible'
      visibilityChangeHandler.current?.()
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      expect(pane.terminal.write).toHaveBeenCalledWith(
        'snapshot-after-hidden-again\r\n',
        expect.any(Function)
      )
      disposable.dispose()
    })

    it('writes a background-origin alternate-screen repaint that arrives after the reveal restore', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 = await vi.importMock<PtyConnectionAgentTitleMocks>(
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
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: {
        current:
          | ((
              data: string,
              meta?: {
                seq?: number
                rawLength?: number
                background?: boolean
                droppedOutput?: boolean
              }
            ) => void)
          | null
      } = { current: null }
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
      const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
      getMainBufferSnapshot.mockResolvedValue({
        data: 'restored-frame',
        cols: 133,
        rows: 40,
        seq: 100,
        alternateScreen: true
      })
      // OpenCode's full repaint after reveal; a differential renderer never repaints these cells again.
      const fullRepaint = '\x1b[H\x1b[2Kfull opencode repaint'

      const pane = createPane(1)
      pane.terminal.cols = 133
      pane.terminal.rows = 40
      ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: true }
      })
      const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
      const settleWrites = async (): Promise<void> => {
        for (let round = 0; round < 8; round += 1) {
          await flushAsyncTicks(2)
          await vi.advanceTimersByTimeAsync(60)
          while (parseCallbacks.length > 0) {
            parseCallbacks.shift()?.()
          }
        }
      }
      const disposable = connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks3)
      )
      await flushAsyncTicks(6)

      capturedDataCallback.current?.('', { seq: 100, rawLength: 0, droppedOutput: true })
      await settleWrites()
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
      expect(writes).toContain('restored-frame')
      transport.resize.mockClear()
      signalPty.mockClear()

      capturedDataCallback.current?.(fullRepaint, {
        seq: 100 + fullRepaint.length,
        rawLength: fullRepaint.length,
        background: true
      })
      await settleWrites()

      expect(writes.join('')).toContain(fullRepaint)
      expect(transport.resize).not.toHaveBeenCalled()
      expect(signalPty).not.toHaveBeenCalled()
      disposable.dispose()
    })

    it('re-restores a skipped alt frame from the model when the fit lands back on the capture grid', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 = await vi.importMock<PtyConnectionAgentTitleMocks>(
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
      const transport = createMockTransport('pty-id')
      const capturedDataCallback: {
        current: ((data: string, meta?: { seq?: number; droppedOutput?: boolean }) => void) | null
      } = { current: null }
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
      // The first replay measures a transient narrower grid; the fit then lands back on the capture grid.
      let narrowUntilWriteCount: number | null = null
      getMainBufferSnapshot.mockImplementation(async () => {
        narrowUntilWriteCount = getMainBufferSnapshot.mock.calls.length === 1 ? writes.length : null
        return {
          data: '\x1b[?1049hcomposed-frame',
          scrollbackAnsi: '',
          frameRestoreAnsi: 'model-frame',
          cols: 133,
          rows: 40,
          seq: 100,
          alternateScreen: true
        }
      })

      const pane = createPane(1)
      pane.terminal.cols = 133
      pane.terminal.rows = 40
      ;(pane.terminal.buffer.active as { type: 'normal' | 'alternate' }).type = 'alternate'
      const { writes, parseCallbacks } = captureCallbackTerminalWrites(pane)
      const manager = createManager(1)
      const deps = createDeps({ isVisibleRef: { current: true } })
      const disposable = connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks4)
      )
      await flushAsyncTicks(6)
      transport.resize.mockClear()
      pane.fitAddon.proposeDimensions.mockImplementation(() =>
        narrowUntilWriteCount === writes.length
          ? { cols: 120, rows: 40 }
          : { cols: pane.terminal.cols, rows: pane.terminal.rows }
      )

      capturedDataCallback.current?.('', { seq: 100, droppedOutput: true })
      for (let round = 0; round < 8; round += 1) {
        await flushAsyncTicks(2)
        await vi.advanceTimersByTimeAsync(60)
        while (parseCallbacks.length > 0) {
          parseCallbacks.shift()?.()
        }
      }

      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
      expect(writes.join('')).toContain('model-frame')
      expect(transport.resize).not.toHaveBeenCalledWith(132, 40)
      disposable.dispose()
    })
  })
}
