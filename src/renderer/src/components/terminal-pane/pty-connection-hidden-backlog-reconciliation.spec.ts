import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DA1_RESPONSE } from './terminal-capability-replies'
import { flushAsyncTicks, createDeferred } from './pty-connection-test-async'
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

export function registerPtyConnectionHiddenBacklogReconciliationTests(): void {
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

    describe('hidden-delivery gate', () => {
      function enableMainAuthority(): void {
        mockStoreState.settings = {
          ...mockStoreState.settings,
          terminalMainSideEffectAuthority: true
        } as StoreState['settings']
      }

      async function connectHiddenPane(deps: ReturnType<typeof createDeps>): Promise<{
        transport: MockTransport
        pane: ReturnType<typeof createPane>
        dataCallback: (
          data: string,
          meta?: { seq?: number; rawLength?: number; droppedOutput?: boolean }
        ) => void
        binding: { syncProcessTracking: () => void; dispose: () => void }
      }> {
        const { connectPanePty } = await import('./pty-connection')
        const transport = createMockTransport('pty-id')
        const capturedDataCallback: {
          current:
            | ((
                data: string,
                meta?: { seq?: number; rawLength?: number; droppedOutput?: boolean }
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
        const pane = createPane(1)
        const manager = createManager(1)
        const binding = connectPanePty(...mockPanePtyArgs(pane, manager, deps))
        await flushAsyncTicks(6)
        expect(capturedDataCallback.current).not.toBeNull()
        return { transport, pane, dataCallback: capturedDataCallback.current!, binding }
      }

      // Only the restore-needed marker proves a byte gap; reset emulator state here with the cross-chunk parser (STA-4042).

      describe('foreground flood restore feedback loop (rc.7.perf)', () => {
        function writtenFloodData(pane: ReturnType<typeof createPane>): string {
          return pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')
        }

        async function startInFlightRestore(): Promise<{
          pane: ReturnType<typeof createPane>
          transport: MockTransport
          dataCallback: (
            data: string,
            meta?: { seq?: number; rawLength?: number; droppedOutput?: boolean }
          ) => void
          getMainBufferSnapshot: ReturnType<typeof vi.fn>
          resolveFirstSnapshot: (snapshot: {
            data: string
            cols: number
            rows: number
            seq: number
          }) => void
        }> {
          enableMainAuthority()
          const deps = createDeps({ isVisibleRef: { current: true } })
          const { pane, transport, dataCallback } = await connectHiddenPane(deps)
          const transportOptions = createdTransportOptions.at(-1) as {
            onPtySpawn?: (ptyId: string) => void
          }
          transportOptions.onPtySpawn?.('pty-id')
          const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
          const firstSnapshot = createDeferred<{
            data: string
            cols: number
            rows: number
            seq: number
          }>()
          getMainBufferSnapshot.mockReturnValueOnce(firstSnapshot.promise).mockResolvedValue({
            data: 'repaint snapshot\r\n',
            cols: 100,
            rows: 30,
            seq: 5_000_000
          })
          const { _dispatchPtyModelRestoreNeededForTest } =
            await import('./pty-model-restore-channel')
          _dispatchPtyModelRestoreNeededForTest({
            id: 'pty-id',
            reason: 'pending-cap',
            markerSeq: 64
          })
          await flushAsyncTicks(4)
          expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
          return {
            pane,
            transport,
            dataCallback,
            getMainBufferSnapshot,
            resolveFirstSnapshot: (snapshot) => firstSnapshot.resolve(snapshot)
          }
        }

        it('abandons the restore on queue overflow, writes the stream through, and repaints once', async () => {
          const { pane, dataCallback, getMainBufferSnapshot, resolveFirstSnapshot } =
            await startInFlightRestore()
          const { markTerminalFollowOutput, markTerminalPinnedViewport } =
            await import('@/lib/pane-manager/terminal-scroll-intent')
          const parseCallbacks: (() => void)[] = []
          pane.terminal.write.mockImplementation(
            (_data: string | Uint8Array, callback?: () => void) => {
              if (callback) {
                parseCallbacks.push(callback)
              }
            }
          )
          pane.terminal.buffer.active.viewportY = 42
          pane.terminal.buffer.active.baseY = 100
          markTerminalPinnedViewport(pane.terminal)

          // Flood while the snapshot is in flight: overflows the 512KB restore queue.
          dataCallback('f'.repeat(300 * 1024), { seq: 300 * 1024 + 64, rawLength: 300 * 1024 })
          dataCallback('g'.repeat(300 * 1024), { seq: 600 * 1024 + 64, rawLength: 300 * 1024 })

          try {
            vi.useFakeTimers()
            resolveFirstSnapshot({ data: 'flood snapshot\r\n', cols: 100, rows: 30, seq: 64 })
            await flushAsyncTicks(20)

            // Cut 1: the overflow abandons the restore instead of re-fetching.
            expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
            pane.terminal.buffer.active.viewportY = 200
            pane.terminal.buffer.active.baseY = 200
            for (const callback of parseCallbacks.splice(0)) {
              callback()
            }
            // The post-replay fit is part of the transaction now; let its promise settle before asserting.
            await flushAsyncTicks(20)
            expect(pane.terminal.scrollToLine).toHaveBeenLastCalledWith(142)

            // Cut 2: drop sentinels and seq-gap chunks during the flood window must not re-arm restores — post-gap bytes write through.
            dataCallback('', { droppedOutput: true })
            dataCallback('AFTER-FLOOD', { seq: 700 * 1024, rawLength: 11 })
            await flushAsyncTicks(8)
            expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
            expect(writtenFloodData(pane)).toContain('AFTER-FLOOD')

            // The repaint only runs while the viewport follows output; return there first.
            markTerminalFollowOutput(pane.terminal)

            // After the flood goes quiet: exactly ONE deferred repaint.
            vi.advanceTimersByTime(2_100)
            await flushAsyncTicks(20)
            expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
            vi.advanceTimersByTime(5_000)
            await flushAsyncTicks(20)
            expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
          } finally {
            vi.useRealTimers()
          }
        })

        it('holds the post-flood repaint while the user reads scrollback and runs it on return to the bottom', async () => {
          const { pane, dataCallback, getMainBufferSnapshot, resolveFirstSnapshot } =
            await startInFlightRestore()
          const { markTerminalFollowOutput, markTerminalPinnedViewport } =
            await import('@/lib/pane-manager/terminal-scroll-intent')
          pane.terminal.buffer.active.viewportY = 42
          pane.terminal.buffer.active.baseY = 100
          markTerminalPinnedViewport(pane.terminal)

          dataCallback('f'.repeat(300 * 1024), { seq: 300 * 1024 + 64, rawLength: 300 * 1024 })
          dataCallback('g'.repeat(300 * 1024), { seq: 600 * 1024 + 64, rawLength: 300 * 1024 })

          try {
            vi.useFakeTimers()
            resolveFirstSnapshot({ data: 'flood snapshot\r\n', cols: 100, rows: 30, seq: 64 })
            await flushAsyncTicks(20)
            expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

            // Quiet flood, but the user is still scrolled back: the clear-and-replay repaint must not move their viewport.
            vi.advanceTimersByTime(2_100)
            await flushAsyncTicks(20)
            expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
            vi.advanceTimersByTime(60_000)
            await flushAsyncTicks(20)
            expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)

            // Returning to the bottom is the event that releases it — the heal is deferred, never dropped.
            pane.terminal.buffer.active.viewportY = pane.terminal.buffer.active.baseY
            markTerminalFollowOutput(pane.terminal)
            await flushAsyncTicks(20)
            expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
          } finally {
            vi.useRealTimers()
          }
        })

        it('sends salvaged queries immediately from an overflowing restore queue', async () => {
          const { pane, transport, dataCallback } = await startInFlightRestore()

          // Queue 400KB, then overflow with color/CPR/DA probes — the discarded probes need direct replies before their read windows close.
          dataCallback('a'.repeat(400 * 1024), { seq: 400 * 1024, rawLength: 400 * 1024 })
          const queries = '\x1b]11;?\x1b\\\x1b[6n\x1b[c'
          dataCallback(`${'b'.repeat(200 * 1024)}${queries}`, {
            seq: 600 * 1024 + queries.length,
            rawLength: 200 * 1024 + queries.length
          })
          await flushAsyncTicks(8)

          const replies = transport.sendInputImmediate.mock.calls.map((call) => String(call[0]))
          // oxlint-disable-next-line no-control-regex -- the ESC byte IS the payload: this matches the CPR reply
          const cprReply = replies.find((reply) => /^\u001b\[\d+;\d+R$/.test(reply))
          const oscReply = replies.find((reply) => reply.startsWith('\x1b]11;rgb:'))
          expect(oscReply).toBeDefined()
          expect(cprReply).toBeDefined()
          expect(replies).toEqual([oscReply, cprReply, DEFAULT_DA1_RESPONSE])
          const written = writtenFloodData(pane)
          expect(written).not.toContain('aaaa')
          expect(written).not.toContain('bbbb')
        })

        it('keeps the hidden-pane drop sentinel arming a reveal restore (gate unchanged)', async () => {
          enableMainAuthority()
          const isVisibleRef = { current: false }
          const deps = createDeps({ isVisibleRef })
          const { pane, dataCallback } = await connectHiddenPane(deps)
          const transportOptions = createdTransportOptions.at(-1) as {
            onPtySpawn?: (ptyId: string) => void
          }
          transportOptions.onPtySpawn?.('pty-id')
          const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
          getMainBufferSnapshot.mockResolvedValue({
            data: 'hidden reveal snapshot\r\n',
            cols: 100,
            rows: 30,
            seq: 64
          })

          // Hidden pane: the sentinel latches restore-needed but must not fetch.
          dataCallback('', { droppedOutput: true })
          await flushAsyncTicks(8)
          expect(getMainBufferSnapshot).not.toHaveBeenCalled()

          // Reveal: the latched restore fetches exactly one snapshot.
          isVisibleRef.current = true
          const { requestTerminalBacklogRecovery } =
            await import('@/lib/pane-manager/pane-terminal-output-scheduler')
          requestTerminalBacklogRecovery(pane.terminal as never)
          await flushAsyncTicks(20)
          expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
          expect(writtenFloodData(pane)).toContain('hidden reveal snapshot')
        })
      })

      describe('post-restore backlog reconciliation', () => {
        async function restoreVisiblePaneToBaseline(): Promise<{
          pane: ReturnType<typeof createPane>
          dataCallback: (data: string, meta?: { seq?: number; rawLength?: number }) => void
          getMainBufferSnapshot: ReturnType<typeof vi.fn>
          transport: MockTransport
          deps: ReturnType<typeof createDeps>
        }> {
          enableMainAuthority()
          const deps = createDeps({ isVisibleRef: { current: true } })
          const { pane, dataCallback, transport } = await connectHiddenPane(deps)
          const transportOptions = createdTransportOptions.at(-1) as {
            onPtySpawn?: (ptyId: string) => void
          }
          transportOptions.onPtySpawn?.('pty-id')
          const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
          getMainBufferSnapshot.mockResolvedValue({
            data: 'restored snapshot\r\n',
            cols: 100,
            rows: 30,
            seq: 64
          })
          const { _dispatchPtyModelRestoreNeededForTest } =
            await import('./pty-model-restore-channel')
          _dispatchPtyModelRestoreNeededForTest({
            id: 'pty-id',
            reason: 'pending-cap',
            markerSeq: 64
          })
          await flushAsyncTicks(20)
          expect(getMainBufferSnapshot).toHaveBeenCalledTimes(1)
          expect(pane.terminal.write).toHaveBeenCalledWith(
            expect.stringContaining('restored snapshot'),
            expect.any(Function)
          )
          pane.terminal.write.mockClear()
          return { pane, dataCallback, getMainBufferSnapshot, transport, deps }
        }

        function writtenData(pane: ReturnType<typeof createPane>): string {
          return pane.terminal.write.mock.calls.map((call) => String(call[0])).join('')
        }

        it('drops backlog chunks the restored snapshot already covers', async () => {
          const { pane, dataCallback } = await restoreVisiblePaneToBaseline()

          // Whole chunk at or before the baseline seq: duplicate, never written.
          dataCallback('OLD-DUPLICATE', { seq: 60, rawLength: 13 })
          await flushAsyncTicks(8)
          expect(writtenData(pane)).not.toContain('OLD-DUPLICATE')

          // Contiguous post-baseline chunk flows through normally.
          dataCallback('NEW', { seq: 67, rawLength: 3 })
          await flushAsyncTicks(8)
          expect(writtenData(pane)).toContain('NEW')
        })

        it('records a 2031 subscribe on a chunk the restored snapshot drops as duplicate', async () => {
          // Scan before duplicate reconciliation: replay omits mode tracking, leaving this delivery as the only subscription evidence.
          enableMainAuthority()
          mockStoreState.settings = {
            ...mockStoreState.settings,
            terminalHiddenDeliveryGate: false
          } as StoreState['settings']
          const { pane, dataCallback, transport, deps } = await restoreVisiblePaneToBaseline()
          transport.sendInput.mockClear()

          dataCallback(`SUB\x1b[?2031h`, { seq: 60, rawLength: 11 })
          await flushAsyncTicks(8)

          expect(writtenData(pane)).not.toContain('SUB')
          expect(deps.paneMode2031Ref.current.get(1)).toBe(true)
          expect(transport.sendInput).not.toHaveBeenCalledWith(expect.stringMatching(/\?997/))
        })

        it('slices a partial overlap when raw and clean lengths match', async () => {
          const { pane, dataCallback } = await restoreVisiblePaneToBaseline()

          // start seq 61 < baseline 64 < end seq 67 — only the last 3 chars are new.
          dataCallback('ABCDEF', { seq: 67, rawLength: 6 })
          await flushAsyncTicks(8)

          const written = writtenData(pane)
          expect(written).toContain('DEF')
          expect(written).not.toContain('ABC')
        })

        it('forces a fresh snapshot for an overlap whose offsets cannot be mapped', async () => {
          const { pane, dataCallback, getMainBufferSnapshot } = await restoreVisiblePaneToBaseline()
          getMainBufferSnapshot.mockResolvedValue({
            data: 'second snapshot\r\n',
            cols: 100,
            rows: 30,
            seq: 80
          })

          // rawLength (6) !== data.length (4): OSC stripping makes the slice offset unmappable — restore from a fresh snapshot instead.
          dataCallback('ABCD', { seq: 67, rawLength: 6 })
          await flushAsyncTicks(20)

          expect(writtenData(pane)).not.toContain('ABCD')
          expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
          expect(writtenData(pane)).toContain('second snapshot')
        })

        it('detects a seq gap after restore and forces another restore', async () => {
          const { pane, dataCallback, getMainBufferSnapshot } = await restoreVisiblePaneToBaseline()
          getMainBufferSnapshot.mockResolvedValue({
            data: 'gap-heal snapshot\r\n',
            cols: 100,
            rows: 30,
            seq: 120
          })

          // Why: a chunk starting past the continuity point means main trimmed bytes after the overflow marker — only the model snapshot can heal the gap.
          dataCallback('AFTER-GAP', { seq: 96, rawLength: 9 })
          await flushAsyncTicks(20)

          expect(writtenData(pane)).not.toContain('AFTER-GAP')
          expect(getMainBufferSnapshot).toHaveBeenCalledTimes(2)
          expect(writtenData(pane)).toContain('gap-heal snapshot')
        })

        it('writes genuinely-new live output whose seq sits below an empty-backlog baseline', async () => {
          // E2E twin: a live chunk's seq sits below main's cumulative baseline, but with an empty pending queue main can never re-deliver — so it must write, not drop.
          enableMainAuthority()
          const isVisibleRef = { current: true }
          const deps = createDeps({ isVisibleRef })
          const { pane, dataCallback } = await connectHiddenPane(deps)
          const transportOptions = createdTransportOptions.at(-1) as {
            onPtySpawn?: (ptyId: string) => void
          }
          transportOptions.onPtySpawn?.('pty-id')
          const getMainBufferSnapshot = vi.mocked(window.api.pty.getMainBufferSnapshot)
          // Visible prompt echo metered in main's cumulative seq domain.
          dataCallback('$ node frame-script.mjs\r\n', { seq: 2_315, rawLength: 25 })
          // Pane hides mid-stream; main drops the hidden frame and marks restore.
          isVisibleRef.current = false
          const { _dispatchPtyModelRestoreNeededForTest } =
            await import('./pty-model-restore-channel')
          _dispatchPtyModelRestoreNeededForTest({
            id: 'pty-id',
            reason: 'hidden-drop',
            markerSeq: 2_472
          })
          // Reveal: the snapshot covers everything ingested; pending queue empty (pendingDeliveryStartSeq === seq).
          getMainBufferSnapshot.mockResolvedValue({
            data: 'LOW_RISK_RESTORE_FRAME_40\r\n',
            cols: 100,
            rows: 30,
            seq: 2_472,
            pendingDeliveryStartSeq: 2_472
          })
          isVisibleRef.current = true
          const { requestTerminalBacklogRecovery } =
            await import('@/lib/pane-manager/pane-terminal-output-scheduler')
          requestTerminalBacklogRecovery(pane.terminal as never)
          await flushAsyncTicks(20)
          expect(writtenData(pane)).toContain('LOW_RISK_RESTORE_FRAME_40')
          pane.terminal.write.mockClear()

          // Newer live frame injected with a seq domain unrelated to main's counter (e2e __terminalPtyDataInjection twin).
          dataCallback('LOW_RISK_RESTORE_FRAME_41\r\n', { seq: 315, rawLength: 27 })
          await flushAsyncTicks(8)
          expect(writtenData(pane)).toContain('LOW_RISK_RESTORE_FRAME_41')

          // The retired baseline keeps subsequent low-seq live chunks flowing.
          dataCallback('progress=041\r\n', { seq: 329, rawLength: 14 })
          await flushAsyncTicks(8)
          expect(writtenData(pane)).toContain('progress=041')
        })

        it('keeps suppressing backlog duplicates inside the reported pending window', async () => {
          const { pane, dataCallback, getMainBufferSnapshot } = await restoreVisiblePaneToBaseline()
          getMainBufferSnapshot.mockResolvedValue({
            data: 'windowed snapshot\r\n',
            cols: 100,
            rows: 30,
            seq: 96,
            pendingDeliveryStartSeq: 80
          })
          const { _dispatchPtyModelRestoreNeededForTest } =
            await import('./pty-model-restore-channel')
          _dispatchPtyModelRestoreNeededForTest({
            id: 'pty-id',
            reason: 'pending-cap',
            markerSeq: 96
          })
          await flushAsyncTicks(20)
          expect(writtenData(pane)).toContain('windowed snapshot')
          pane.terminal.write.mockClear()

          // Inside the pending window (80, 96]: a draining backlog duplicate.
          dataCallback('IN-WINDOW-DUP-16', { seq: 96, rawLength: 16 })
          await flushAsyncTicks(8)
          expect(writtenData(pane)).not.toContain('IN-WINDOW-DUP-16')

          // Past the baseline: genuinely-new live output still flows.
          dataCallback('PAST-BASELINE', { seq: 109, rawLength: 13 })
          await flushAsyncTicks(8)
          expect(writtenData(pane)).toContain('PAST-BASELINE')

          // Below the pending window (≤ 80): main can never re-send these seqs, so this foreign seq domain is written, never dropped.
          dataCallback('BELOW-WINDOW', { seq: 60, rawLength: 12 })
          await flushAsyncTicks(8)
          expect(writtenData(pane)).toContain('BELOW-WINDOW')
        })
      })
    })
  })
}
