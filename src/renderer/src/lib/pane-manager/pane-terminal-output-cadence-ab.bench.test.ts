import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A/B cadence harness for the frame-gate rollout: replays a passive
// tiny-chunk agent stream against the real scheduler under fake timers with
// a simulated 60Hz display, and reports renderer drain tasks and xterm
// writes per second. Run on two checkouts to compare before/after:
//   ORCA_TERMINAL_CADENCE_BENCH=1 pnpm vitest run \
//     src/renderer/src/lib/pane-manager/pane-terminal-output-cadence-ab.bench.test.ts \
//     --config config/vitest.config.ts --silent=false --disable-console-intercept
const benchEnabled = process.env.ORCA_TERMINAL_CADENCE_BENCH === '1'

vi.mock('@/lib/e2e-config', () => ({
  e2eConfig: { exposeStore: true }
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

type SchedulerDebugApi = {
  reset: () => void
  snapshot: () => {
    deferredForegroundEnqueueCount: number
    deferredForegroundWriteCount: number
    foregroundWriteCount: number
    scheduledDrainCount: number
    drainWrites: number[]
  }
}

const SIMULATED_SECONDS = 10
// Fractional 60Hz interval: integer 16ms would gate at 62.5 frames/s and
// overstate the frame-capped delivery ceiling.
const FRAME_INTERVAL_MS = 1000 / 60
const CHUNK_BYTES = 80

function createTerminal() {
  return {
    write: vi.fn((_data: string, callback?: () => void) => {
      callback?.()
    })
  }
}

async function measureRate(chunksPerSecond: number): Promise<{
  deliveries: number
  xtermWrites: number
  drainTasks: number
  frameRequests: number
}> {
  vi.resetModules()
  delete (globalThis as { __terminalOutputSchedulerDebug?: unknown }).__terminalOutputSchedulerDebug

  let frameRequests = 0
  const pendingFrames: FrameRequestCallback[] = []
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frameRequests += 1
      pendingFrames.push(callback)
      return frameRequests
    })
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn(() => {
      // The driver fires all pending frames each interval; a cancelled frame
      // is generation-guarded inside the gate, so draining the array is safe.
    })
  )

  const scheduler = await import('./pane-terminal-output-scheduler')
  const terminal = createTerminal()
  const chunk = `${'x'.repeat(CHUNK_BYTES - 1)}\n`
  const chunkIntervalMs = 1000 / chunksPerSecond
  const totalMs = SIMULATED_SECONDS * 1000
  let deliveries = 0
  let nextChunkAt = 0
  let nextFrameAt = 0

  for (let now = 0; now <= totalMs; now += 1) {
    if (now >= nextFrameAt && pendingFrames.length > 0) {
      const frames = pendingFrames.splice(0, pendingFrames.length)
      for (const frame of frames) {
        frame(now)
      }
      nextFrameAt += FRAME_INTERVAL_MS
    }
    while (now >= nextChunkAt && deliveries < chunksPerSecond * SIMULATED_SECONDS) {
      scheduler.writeTerminalOutput(terminal as never, chunk, {
        foreground: true,
        latencySensitive: false
      })
      deliveries += 1
      nextChunkAt += chunkIntervalMs
    }
    vi.advanceTimersByTime(1)
  }
  // Let any trailing frame/fallback drain settle.
  for (const frame of pendingFrames.splice(0, pendingFrames.length)) {
    frame(totalMs)
  }
  vi.advanceTimersByTime(64)

  const debug = (globalThis as unknown as { __terminalOutputSchedulerDebug?: SchedulerDebugApi })
    .__terminalOutputSchedulerDebug
  if (!debug) {
    throw new Error('Scheduler debug API missing — e2e config mock did not apply')
  }
  const snapshot = debug.snapshot()
  const written = terminal.write.mock.calls.reduce(
    (total, [data]) => total + (data as string).length,
    0
  )
  expect(written).toBe(deliveries * CHUNK_BYTES)
  return {
    deliveries,
    xtermWrites: terminal.write.mock.calls.length,
    drainTasks: snapshot.drainWrites.length,
    frameRequests
  }
}

describe.skipIf(!benchEnabled)('passive output cadence A/B', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete (globalThis as { __terminalOutputSchedulerDebug?: unknown })
      .__terminalOutputSchedulerDebug
  })

  it('reports drain tasks and xterm writes per second across chunk rates', async () => {
    const rows: string[] = []
    for (const rate of [30, 60, 125, 250, 500]) {
      const result = await measureRate(rate)
      rows.push(
        `[cadence-ab] rate=${rate}/s deliveries=${result.deliveries} ` +
          `xtermWrites=${result.xtermWrites} (${(result.xtermWrites / SIMULATED_SECONDS).toFixed(1)}/s) ` +
          `drainTasks=${result.drainTasks} (${(result.drainTasks / SIMULATED_SECONDS).toFixed(1)}/s) ` +
          `frameRequests=${result.frameRequests}`
      )
    }
    // eslint-disable-next-line no-console -- bench harness output
    console.log(`\n${rows.join('\n')}`)
  })
})
