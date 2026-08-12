import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Benchmark harness for the terminal performance initiative: measures the
// scheduler-imposed drain ceiling in isolation. A mock terminal parses
// instantly, so the measured rate is pure scheduler drip (writes-per-tick x
// chunk size / reschedule interval). Baseline-jul02 measured agent-tui at
// 2.0 MB/s end-to-end while bare xterm parses the same bytes at ~103 MB/s;
// this pins how much of that ceiling the drain loop itself imposes.
// Run with:
//   ORCA_TERMINAL_PERF_BENCH=1 pnpm vitest run \
//     src/renderer/src/lib/pane-manager/pane-terminal-output-scheduler-throughput.bench.test.ts \
//     --config config/vitest.config.ts
const benchEnabled = process.env.ORCA_TERMINAL_PERF_BENCH === '1'

vi.mock('@/lib/e2e-config', () => ({
  e2eConfig: { exposeStore: false }
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

const TOTAL_CHARS = 4 * 1024 * 1024
const FEED_CHUNK_CHARS = 8 * 1024
const MAX_SIMULATED_MS = 60_000

function createInstantParseTerminal() {
  let written = 0
  return {
    get written() {
      return written
    },
    buffer: { active: { cursorY: 0, baseY: 0, viewportY: 0 } },
    rows: 24,
    refresh: vi.fn(),
    _core: { refresh: vi.fn() },
    write: vi.fn((data: string, callback?: () => void) => {
      written += data.length
      callback?.()
    })
  }
}

async function loadScheduler() {
  vi.resetModules()
  return import('./pane-terminal-output-scheduler')
}

async function measure(options: { foreground: boolean }): Promise<number> {
  vi.useFakeTimers()
  const scheduler = await loadScheduler()
  const terminal = createInstantParseTerminal()
  const payload = 'x'.repeat(FEED_CHUNK_CHARS)
  // Why paced feeding: dumping the whole payload trips the backlog cap
  // (replaceBacklogWithWarning). Real sources are paced by main's 512KB
  // delivery watermark; keep in-flight below a 256KB window like a live PTY.
  const IN_FLIGHT_WINDOW_CHARS = 256 * 1024
  let fed = 0
  let elapsed = 0
  while (terminal.written < TOTAL_CHARS && elapsed < MAX_SIMULATED_MS) {
    while (fed < TOTAL_CHARS && fed - terminal.written < IN_FLIGHT_WINDOW_CHARS) {
      scheduler.writeTerminalOutput(terminal as never, payload, {
        foreground: options.foreground,
        // Why false: floods are classified latency-insensitive by
        // pty-connection's isLatencySensitiveForegroundOutput once the
        // immediate budget is spent — this is the sustained-throughput path.
        latencySensitive: false
      })
      fed += FEED_CHUNK_CHARS
    }
    vi.advanceTimersByTime(1)
    elapsed += 1
  }
  expect(terminal.written).toBe(TOTAL_CHARS)
  return TOTAL_CHARS / 1024 / 1024 / (elapsed / 1000)
}

describe.skipIf(!benchEnabled)('scheduler drain ceiling', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('measures foreground (visible pane flood) and background ceilings', async () => {
    const foreground = await measure({ foreground: true })
    const background = await measure({ foreground: false })
    // eslint-disable-next-line no-console -- bench harness output
    console.log(
      `\n[scheduler-ceiling] foreground flood: ${foreground.toFixed(1)} MB/s, background: ${background.toFixed(1)} MB/s (simulated time, instant parse)`
    )
  })
})

// Real-timer smoke: the MessageChannel drain path must actually drain a
// high-priority backlog without any timer advancing (the clamp-dodge works).
import { setUseMessageChannelDrainForTesting } from './pane-terminal-output-scheduler'

describe('message-channel drain path', () => {
  it('drains high-priority output with real timers and no timer advance', async () => {
    vi.useRealTimers()
    setUseMessageChannelDrainForTesting(true)
    try {
      const writes: string[] = []
      const terminal = {
        write: (data: string, cb?: () => void) => {
          writes.push(data)
          cb?.()
        }
      }
      const { writeTerminalOutput, discardTerminalOutput } =
        await import('./pane-terminal-output-scheduler')
      for (let i = 0; i < 40; i++) {
        writeTerminalOutput(terminal as never, `chunk-${i};`, { foreground: true })
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(writes.join('')).toContain('chunk-39;')
      discardTerminalOutput(terminal as never)
    } finally {
      setUseMessageChannelDrainForTesting(null)
      vi.useFakeTimers()
    }
  })
})
