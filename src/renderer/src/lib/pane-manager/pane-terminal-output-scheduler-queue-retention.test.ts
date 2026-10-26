import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadScheduler } from './pane-terminal-output-scheduler-test-harness'

vi.mock('@/lib/e2e-config', () => ({
  e2eConfig: { exposeStore: true }
}))

const mocks = vi.hoisted(() => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: mocks.recordRendererCrashBreadcrumb
}))

describe('pane terminal output scheduler', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis)
    mocks.recordRendererCrashBreadcrumb.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as { __terminalOutputSchedulerDebug?: unknown })
      .__terminalOutputSchedulerDebug
    vi.unstubAllGlobals()
  })

  describe('queue memory retention (STA-3567)', () => {
    // Why 2 MB: comfortably above BACKGROUND_CHUNK_CHARS (16 K), so every drain leaves a residual slice.
    const CHUNK_CHARS = 2 * 1024 * 1024
    const TERMINALS = 8

    function collect(): number {
      const gc = (globalThis as { gc?: () => void }).gc
      if (!gc) {
        throw new Error('global.gc unavailable - config/vitest.config.ts must pass --expose-gc')
      }
      gc()
      gc()
      return process.memoryUsage().heapUsed
    }

    it('releases chunks it has already drained past', async () => {
      vi.useFakeTimers()
      const { writeTerminalOutput } = await loadScheduler()

      // Below 64 consumed chunks, compaction does not splice; drained slots must release strings individually.
      const CHUNKS_PER_TERMINAL = 40
      const CHUNK = 48 * 1024
      const SINKS = 4

      let writtenChars = 0
      const terminals = Array.from({ length: SINKS }, () => ({
        write: (data: string, callback?: () => void) => {
          writtenChars += data.length
          callback?.()
        }
      }))

      const baseline = collect()

      for (const [index, terminal] of terminals.entries()) {
        for (let chunk = 0; chunk < CHUNKS_PER_TERMINAL; chunk += 1) {
          writeTerminalOutput(
            terminal,
            String.fromCharCode(65 + index) +
              String.fromCharCode(48 + (chunk % 10)) +
              'q'.repeat(CHUNK - 2),
            { foreground: false, latencySensitive: false }
          )
        }
      }

      const debug = (
        globalThis as {
          __terminalOutputSchedulerDebug?: { snapshot: () => { queuedChars: number } }
        }
      ).__terminalOutputSchedulerDebug
      if (!debug) {
        throw new Error('scheduler debug API unavailable')
      }

      const TAIL_CHARS = 64 * 1024
      let ticks = 0
      while (debug.snapshot().queuedChars > TAIL_CHARS && ticks < 40000) {
        vi.advanceTimersByTime(4)
        ticks += 1
      }

      const queuedChars = debug.snapshot().queuedChars
      const retainedBytes = collect() - baseline

      // Sanity: the queues really drained down, and none hit the backlog cap.
      expect(writtenChars).toBeGreaterThan(SINKS * CHUNKS_PER_TERMINAL * CHUNK * 0.9)
      expect(queuedChars).toBeGreaterThan(0)
      expect(queuedChars).toBeLessThanOrEqual(TAIL_CHARS)

      // The defect: ~39 drained-past slots per terminal kept their strings alive uncharged.
      expect(retainedBytes).toBeLessThan(2 * 1024 * 1024)
    })

    it('does not pin the parent when a producer enqueues a slice', async () => {
      vi.useFakeTimers()
      const { writeTerminalOutput } = await loadScheduler()

      // Producers can hand off slices of large buffers (OSC/restore trimming); the queue must own copies rather than pin parents (STA-3567).
      const KEEP_CHARS = 64 * 1024
      const sinks = Array.from({ length: TERMINALS }, () => ({
        write: (_data: string, callback?: () => void) => callback?.()
      }))

      const baseline = collect()

      for (const [index, sink] of sinks.entries()) {
        const parent = String.fromCharCode(65 + index) + 'q'.repeat(CHUNK_CHARS - 1)
        writeTerminalOutput(sink, parent.slice(parent.length - KEEP_CHARS), {
          foreground: false,
          latencySensitive: false
        })
      }

      const retainedBytes = collect() - baseline

      // 8 x 64 KB of real payload must not keep 8 x 2 MB of parents alive.
      expect(retainedBytes).toBeLessThan(4 * 1024 * 1024)
    })

    it('drops the parent chunk once only a small tail is still queued', async () => {
      vi.useFakeTimers()
      const { writeTerminalOutput } = await loadScheduler()

      // Avoid vi.fn: mock.calls would retain the measured bytes independently of the queue.
      let writtenChars = 0
      const makeSink = (): { write: (data: string, callback?: () => void) => void } => ({
        write: (data: string, callback?: () => void) => {
          writtenChars += data.length
          callback?.()
        }
      })
      const terminals = Array.from({ length: TERMINALS }, makeSink)

      // Measure baseline before enqueue; afterwards the owned copies already mask whether residual flattening releases parents.
      const baseline = collect()

      for (const [index, terminal] of terminals.entries()) {
        // Built and dropped inline so only the queue's own copy stays reachable.
        writeTerminalOutput(
          terminal,
          String.fromCharCode(65 + index) + 'q'.repeat(CHUNK_CHARS - 1),
          { foreground: false, latencySensitive: false }
        )
      }

      const debug = (
        globalThis as {
          __terminalOutputSchedulerDebug?: { snapshot: () => { queuedChars: number } }
        }
      ).__terminalOutputSchedulerDebug
      if (!debug) {
        throw new Error('scheduler debug API unavailable')
      }

      // Stop partially drained; an empty queue frees buffers even with the leak present.
      const TAIL_CHARS = 64 * 1024
      let ticks = 0
      while (debug.snapshot().queuedChars > TAIL_CHARS && ticks < 20000) {
        vi.advanceTimersByTime(4)
        ticks += 1
      }

      const queuedChars = debug.snapshot().queuedChars
      const retainedBytes = collect() - baseline

      // Require both substantial drain and a real tail; otherwise residual-parent retention is untested.
      expect(writtenChars).toBeGreaterThan(TERMINALS * CHUNK_CHARS * 0.9)
      expect(queuedChars).toBeGreaterThan(0)
      expect(queuedChars).toBeLessThanOrEqual(TAIL_CHARS)

      // The defect: those few queued KB pinned 8 x 2 MB of chunks (~16 MB).
      expect(retainedBytes).toBeLessThan(4 * 1024 * 1024)
    })
  })
})
