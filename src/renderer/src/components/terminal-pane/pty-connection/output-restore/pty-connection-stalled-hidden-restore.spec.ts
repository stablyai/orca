import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildKittyKeyboardRestore,
  RESET_AFTER_BYTE_GAP
} from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { flushAsyncTicks, createDeferred } from '../test-fixtures/pty-connection-test-async'
import { NORMAL_BUFFER_PROLOGUE } from '../test-fixtures/pty-connection-test-constants'
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

// An abandon re-asserts the (known-zero) mirror's kitty flags after grounding the gap.
const ABANDONED_RESTORE_GAP = `${RESET_AFTER_BYTE_GAP}${buildKittyKeyboardRestore(0)}`

export function registerPtyConnectionStalledHiddenRestoreTests(): void {
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

    it('abandons a stalled hidden restore with reset, warning, then pending foreground', async () => {
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
      const snapshot = createDeferred<{ data: string; cols: number; rows: number; seq: number }>()
      getMainBufferSnapshot.mockReturnValue(snapshot.promise)
      const hidden = 'hidden-codex-output\r\n'
      const firstLive = 'first-live-output\r\n'
      const secondLive = 'second-live-output\r\n'

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      })
      const disposable = connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks)
      )
      await flushAsyncTicks(6)

      expect(capturedDataCallback.current).not.toBeNull()
      vi.useFakeTimers()
      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(firstLive, {
        seq: hidden.length + firstLive.length,
        rawLength: firstLive.length
      })
      await flushAsyncTicks(4)
      capturedDataCallback.current?.(secondLive, {
        seq: hidden.length + firstLive.length + secondLive.length,
        rawLength: secondLive.length
      })

      expect(getMainBufferSnapshot).toHaveBeenCalledWith('pty-id', { scrollbackRows: 5000 })
      expect(pane.terminal.write).not.toHaveBeenCalledWith(firstLive, expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith(secondLive, expect.any(Function))

      vi.advanceTimersByTime(749)
      await flushAsyncTicks(4)
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        expect.stringContaining('main recovery was unavailable'),
        expect.any(Function)
      )

      vi.advanceTimersByTime(1)
      vi.advanceTimersByTime(0)
      await flushAsyncTicks(10)

      const written = pane.terminal.write.mock.calls.map(([data]) => data as string)
      const warningIndex = written.findIndex((data) =>
        data.includes('main recovery was unavailable')
      )
      const combinedLiveIndex = written.indexOf(firstLive + secondLive)
      expect(warningIndex).toBeGreaterThanOrEqual(0)
      expect(written[warningIndex - 1]).toBe(ABANDONED_RESTORE_GAP)
      // Warning already grounds the gap; a second unconditional reset would duplicate it.
      expect(written.filter((data) => data === ABANDONED_RESTORE_GAP)).toHaveLength(1)
      expect(combinedLiveIndex).toBeGreaterThan(warningIndex)

      snapshot.resolve({
        data: 'late-snapshot-state\r\n',
        cols: 100,
        rows: 30,
        seq: hidden.length + firstLive.length + secondLive.length
      })
      await flushAsyncTicks(20)

      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        'late-snapshot-state\r\n',
        expect.any(Function)
      )
      disposable.dispose()
    })

    it('drops pending foreground overflow when a stalled hidden restore falls back', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 = await vi.importMock<PtyConnectionAgentTitleMocks>(
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
      getMainBufferSnapshot.mockReturnValue(
        createDeferred<{ data: string; cols: number; rows: number; seq: number }>().promise
      )
      const hidden = 'hidden-codex-output\r\n'
      const liveOverflow = 'v'.repeat(512 * 1024 + 1)

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      })
      const disposable = connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks5)
      )
      await flushAsyncTicks(6)

      expect(capturedDataCallback.current).not.toBeNull()
      vi.useFakeTimers()
      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(liveOverflow, {
        seq: hidden.length + liveOverflow.length,
        rawLength: liveOverflow.length
      })
      await flushAsyncTicks(4)

      await vi.advanceTimersByTimeAsync(750)
      await flushAsyncTicks(20)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        expect.stringContaining('main recovery was unavailable'),
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(liveOverflow, expect.any(Function))
      disposable.dispose()
    })

    it('keeps a newer same-PTY hidden restore after a timed-out snapshot resolves late', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks8 = await vi.importMock<PtyConnectionAgentTitleMocks>(
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
      const firstSnapshot = createDeferred<{
        data: string
        cols: number
        rows: number
        seq: number
      }>()
      const secondSnapshot = createDeferred<{
        data: string
        cols: number
        rows: number
        seq: number
      }>()
      getMainBufferSnapshot
        .mockReturnValueOnce(firstSnapshot.promise)
        .mockReturnValueOnce(secondSnapshot.promise)
      const firstHidden = 'first-hidden-output\r\n'
      const firstLive = 'first-live-output\r\n'
      const secondHidden = 'second-hidden-output\r\n'
      const secondLive = 'second-live-output\r\n'

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: false },
        startup: { command: 'codex' }
      })
      const disposable = connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks8)
      )
      await flushAsyncTicks(6)

      expect(capturedDataCallback.current).not.toBeNull()
      vi.useFakeTimers()
      capturedDataCallback.current?.(firstHidden, {
        seq: firstHidden.length,
        rawLength: firstHidden.length
      })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(firstLive, {
        seq: firstHidden.length + firstLive.length,
        rawLength: firstLive.length
      })
      await flushAsyncTicks(4)
      vi.advanceTimersByTime(750)
      vi.advanceTimersByTime(0)
      await flushAsyncTicks(10)

      pane.terminal.write.mockClear()
      ;(deps.isVisibleRef as { current: boolean }).current = false
      capturedDataCallback.current?.(secondHidden, {
        seq: firstHidden.length + firstLive.length + secondHidden.length,
        rawLength: secondHidden.length
      })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(secondLive, {
        seq: firstHidden.length + firstLive.length + secondHidden.length + secondLive.length,
        rawLength: secondLive.length
      })
      await flushAsyncTicks(4)
      expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)

      firstSnapshot.resolve({
        data: 'stale-first-snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: firstHidden.length + firstLive.length
      })
      await flushAsyncTicks(10)
      secondSnapshot.resolve({
        data: 'fresh-second-snapshot\r\n',
        cols: 100,
        rows: 30,
        seq: firstHidden.length + firstLive.length + secondHidden.length + secondLive.length
      })
      await flushAsyncTicks(20)

      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        'stale-first-snapshot\r\n',
        expect.any(Function)
      )
      expect(pane.terminal.write).toHaveBeenCalledWith(
        'fresh-second-snapshot\r\n',
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(secondLive, expect.any(Function))
      disposable.dispose()
    })

    it('ignores an async hidden-backlog snapshot if the pane changes PTYs first', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks9 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('old-pty-id')
      const capturedDataCallback: {
        current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'old-pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      const snapshot = createDeferred<{ data: string; cols: number; rows: number; seq: number }>()
      getMainBufferSnapshot.mockReturnValue(snapshot.promise)
      const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
      const live = 'old-live-output\r\n'

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: false }
      })
      const disposable = connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks9)
      )
      await flushAsyncTicks(6)

      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(live, {
        seq: hidden.length + live.length,
        rawLength: live.length
      })
      await flushAsyncTicks(2)
      transport.getPtyId.mockReturnValue('new-pty-id')
      snapshot.resolve({
        data: 'old-snapshot-state\r\n',
        cols: 100,
        rows: 30,
        seq: hidden.length + live.length
      })
      await flushAsyncTicks(20)

      expect(getMainBufferSnapshot).toHaveBeenCalledWith('old-pty-id', { scrollbackRows: 5000 })
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        'old-snapshot-state\r\n',
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
      disposable.dispose()
    })

    it('does not recover stale hidden backlog state after the pane switches PTYs', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks10 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('old-pty-id')
      const capturedDataCallback: {
        current: ((data: string, meta?: { seq?: number; rawLength?: number }) => void) | null
      } = { current: null }
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'old-pty-id'
        }
      )
      transportFactoryQueue.push(transport)
      const getMainBufferSnapshot = window.api.pty.getMainBufferSnapshot as unknown as ReturnType<
        typeof vi.fn
      >
      const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
      const newPtyOutput = 'new-pty-output\r\n'

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: false }
      })
      const disposable = connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks10)
      )
      await flushAsyncTicks(6)

      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      transport.getPtyId.mockReturnValue('new-pty-id')
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(newPtyOutput, {
        seq: newPtyOutput.length,
        rawLength: newPtyOutput.length
      })
      await flushAsyncTicks(10)

      expect(getMainBufferSnapshot).not.toHaveBeenCalled()
      expect(pane.terminal.write).toHaveBeenCalledWith(newPtyOutput, expect.any(Function))
      disposable.dispose()
    })

    it('does not replay pending hidden restore chunks after a terminal clear', async () => {
      const clearBufferCallback: {
        current: ((request: { ptyId: string }) => void) | null
      } = { current: null }
      window.api.pty.onClearBufferRequest = vi.fn((callback) => {
        clearBufferCallback.current = callback as (request: { ptyId: string }) => void
        return vi.fn()
      })
      // The serializer subscribes to window.api once per module load.
      await loadFreshTerminalModules()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks11 = await vi.importMock<PtyConnectionAgentTitleMocks>(
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
      const snapshot = createDeferred<{ data: string; cols: number; rows: number; seq: number }>()
      getMainBufferSnapshot.mockReturnValue(snapshot.promise)
      const hidden = 'x'.repeat(2 * 1024 * 1024 + 1)
      const live = 'pre-clear-live-output\r\n'

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        isVisibleRef: { current: false }
      })
      const disposable = connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks11)
      )
      await flushAsyncTicks(6)

      capturedDataCallback.current?.(hidden, { seq: hidden.length, rawLength: hidden.length })
      ;(deps.isVisibleRef as { current: boolean }).current = true
      capturedDataCallback.current?.(live, {
        seq: hidden.length + live.length,
        rawLength: live.length
      })
      await flushAsyncTicks(2)
      expect(clearBufferCallback.current).not.toBeNull()

      clearBufferCallback.current?.({ ptyId: 'pty-id' })
      snapshot.resolve({
        data: '',
        cols: 120,
        rows: 40,
        seq: hidden.length + live.length
      })
      await flushAsyncTicks(20)

      expect(pane.terminal.clear).toHaveBeenCalled()
      expect(pane.terminal.write).not.toHaveBeenCalledWith(live, expect.any(Function))
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        NORMAL_BUFFER_PROLOGUE,
        expect.any(Function)
      )
      disposable.dispose()
    })
  })
}
