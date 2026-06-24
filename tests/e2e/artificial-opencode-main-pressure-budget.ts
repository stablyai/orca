import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import type {
  MainPressureAckGate,
  MainPressureMeasurement,
  MainPressureSchedulerSnapshot,
  MainPressureSnapshot
} from './artificial-opencode-main-pressure-scenario'

// Why: peak queued chars is noisy at the byte level on CI, but a coarse cap
// still catches renderer queue growth that dropped-backlog/latency checks miss.
const MAX_RENDERER_SCHEDULER_QUEUED_CHARS = 5 * 1024 * 1024
const PRESSURE_STEADY_SAMPLE_MS = 100
const PRESSURE_STEADY_SAMPLE_COUNT = 4
const PRESSURE_STEADY_MAX_PENDING_GROWTH_CHARS = 64 * 1024

export async function waitForMainPressureTypingReadiness<
  TMainPressure extends MainPressureSnapshot
>({
  backgroundPaneCount,
  readMainPtyPressureDebug,
  orcaPage
}: {
  backgroundPaneCount: number
  readMainPtyPressureDebug: (page: Page) => Promise<TMainPressure | null>
  orcaPage: Page
}): Promise<void> {
  let previous: TMainPressure | null = null
  let steadySamples = 0
  await expect
    .poll(
      async () => {
        const current = await readMainPtyPressureDebug(orcaPage)
        if (!current || (current.sourcePausedPtyCount ?? 0) < backgroundPaneCount) {
          previous = current
          steadySamples = 0
          return false
        }
        const pendingChars = current.pendingChars ?? 0
        const previousPendingChars = previous?.pendingChars ?? pendingChars
        const pendingGrowth = pendingChars - previousPendingChars
        previous = current
        if (
          pendingGrowth > PRESSURE_STEADY_MAX_PENDING_GROWTH_CHARS ||
          current.flushScheduled === true
        ) {
          steadySamples = 0
          return false
        }
        steadySamples += 1
        return steadySamples >= PRESSURE_STEADY_SAMPLE_COUNT
      },
      {
        intervals: Array(PRESSURE_STEADY_SAMPLE_COUNT + 4).fill(PRESSURE_STEADY_SAMPLE_MS),
        timeout: 10_000,
        message: () =>
          `Main PTY pressure did not settle before typing\n${JSON.stringify(previous, null, 2)}`
      }
    )
    .toBe(true)
}

export function expectMainPressureAndTyping<TMeasurement extends MainPressureMeasurement>({
  ackGate,
  mainPressure,
  maxMedianKeyLatencyMs,
  maxTimerDriftMs,
  maxWorstKeyLatencyMs,
  measurement,
  pressureBeforeTyping,
  scheduler
}: {
  ackGate: MainPressureAckGate | null
  mainPressure: MainPressureSnapshot | null
  maxMedianKeyLatencyMs: number
  maxTimerDriftMs: number
  maxWorstKeyLatencyMs: number
  measurement: TMeasurement
  pressureBeforeTyping: MainPressureSnapshot
  scheduler: MainPressureSchedulerSnapshot | null
}): void {
  expect(pressureBeforeTyping.peakPendingChars).toBeGreaterThan(0)
  expect(pressureBeforeTyping.sourcePausedPtyCount ?? 0).toBeGreaterThan(0)
  expect(
    (mainPressure?.peakRendererInFlightChars ?? 0) >= 8 * 1024 * 1024 ||
      (mainPressure?.sourcePausedPtyCount ?? 0) > 0
  ).toBe(true)
  expect(ackGate?.heldAckChars ?? 0).toBeGreaterThan(0)
  expect(scheduler?.droppedBacklogCount ?? Number.POSITIVE_INFINITY).toBe(0)
  expect(scheduler?.peakQueuedChars ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    MAX_RENDERER_SCHEDULER_QUEUED_CHARS
  )
  expect(measurement.medianLatencyMs).toBeLessThan(maxMedianKeyLatencyMs)
  expect(measurement.worstLatencyMs).toBeLessThan(maxWorstKeyLatencyMs)
  expect(measurement.maxTimerDriftMs).toBeLessThan(maxTimerDriftMs)
}
