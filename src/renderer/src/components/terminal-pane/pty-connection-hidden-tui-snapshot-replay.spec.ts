import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
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

export function registerPtyConnectionHiddenTuiSnapshotReplayTests(): void {
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

    it('replays rich headless snapshots as the future hidden TUI view source', async () => {
      const { connectPanePty } = await import('./pty-connection')
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
      const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
      const richSnapshot = [
        '\x1b[?1049h',
        '\x1b[2J\x1b[H',
        '\x1b[?25l',
        '\x1b[2;36m╭────────────────────────────╮\x1b[0m\r\n',
        '\x1b[2;36m│ Codex rich restore 🟢 ███░ │\x1b[0m\r\n',
        '\x1b[2;36m│ status streaming           │\x1b[0m\r\n',
        '\x1b[2;36m╰────────────────────────────╯\x1b[0m',
        '\x1b[6;4H\x1b[?25h'
      ].join('')
      const visibleTrigger = 'visible-trigger\r\n'
      getMainBufferSnapshot.mockResolvedValue({
        data: richSnapshot,
        cols: 96,
        rows: 18,
        seq: hidden.length + visibleTrigger.length,
        source: 'headless'
      })

      const pane = createPane(1)
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: false }
      })
      const disposable = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(visibleTrigger, {
        seq: hidden.length + visibleTrigger.length,
        rawLength: visibleTrigger.length
      })
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
      expect(pane.terminal.resize).toHaveBeenCalledWith(96, 18)
      expect(pane.terminal.write).toHaveBeenCalledWith(richSnapshot, expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith(visibleTrigger, expect.any(Function))
      expect(refresh).toHaveBeenCalledWith(0, 39, true)
      expect(deps.replayingPanesRef.current.size).toBe(0)
      disposable.dispose()
    })

    it('refreshes visible rows after replaying a hidden TUI snapshot', async () => {
      const { connectPanePty } = await import('./pty-connection')
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
      const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
      const live = '\x1b[?2026h\x1b[2J\x1b[H╭────╮\r\n│ ok │\r\n╰────╯\x1b[?2026l'
      getMainBufferSnapshot.mockResolvedValue({
        data: live,
        cols: 120,
        rows: 40,
        seq: hidden.length + live.length
      })

      const pane = createPane(1)
      const refresh = vi.fn()
      const terminal = pane.terminal as typeof pane.terminal & {
        _core?: { refresh: typeof refresh }
      }
      terminal._core = { refresh }
      terminal.write = vi.fn((_data: string, callback?: () => void) => {
        callback?.()
      })
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: false }
      })
      const disposable = connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(6)

      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(live, {
        seq: hidden.length + live.length,
        rawLength: live.length
      })
      await flushAsyncTicks(20)

      // Why: hidden restore replays bypass live foreground output; force a paint after parse so stale WebGL cells can't survive.
      expect(refresh).toHaveBeenCalledWith(0, 39, true)
      expect(deps.replayingPanesRef.current.size).toBe(0)
      disposable.dispose()
    })
  })
}
