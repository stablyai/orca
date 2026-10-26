import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Measure scheduler ceiling with instant mock parsing (writes/tick × chunk size ÷ interval); real end-to-end throughput was 2MB/s versus ~103MB/s bare xterm. Run with ORCA_TERMINAL_PERF_BENCH=1 pnpm vitest run src/renderer/src/lib/pane-manager/pane-terminal-output-scheduler-throughput.bench.test.ts --config config/vitest.config.ts.
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
  // Pace below 256KB in-flight to avoid backlog replacement, matching sources bounded by main’s 512KB delivery watermark.
  const IN_FLIGHT_WINDOW_CHARS = 256 * 1024
  let fed = 0
  let elapsed = 0
  while (terminal.written < TOTAL_CHARS && elapsed < MAX_SIMULATED_MS) {
    while (fed < TOTAL_CHARS && fed - terminal.written < IN_FLIGHT_WINDOW_CHARS) {
      scheduler.writeTerminalOutput(terminal as never, payload, {
        foreground: options.foreground,
        // Model sustained floods, classified latency-insensitive after the immediate budget is spent.
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
    console.log(
      `\n[scheduler-ceiling] foreground flood: ${foreground.toFixed(1)} MB/s, background: ${background.toFixed(1)} MB/s (simulated time, instant parse)`
    )
  })
})

// Real timers prove MessageChannel drains high-priority output without virtual-clock advancement.
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
