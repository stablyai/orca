/**
 * Main-thread blocking census for the typing-latency probe.
 *
 * Why: echo latency says the keystroke was slow but not why. A keystroke can
 * only be served between tasks, so long tasks are the budget the echo competes
 * for. Sampling them alongside the echo separates "the terminal write path is
 * slow" from "the renderer had no free main thread" — the latter points at
 * whatever else is committing, not at the pane.
 */

type LongTaskSample = {
  durationMs: number
  startedAt: number
}

export type MainThreadBlockingCensus = {
  supported: boolean
  windowMs: number
  taskCount: number
  blockedMs: number
  blockedPercent: number
  longestTaskMs: number
  p50TaskMs: number
  p95TaskMs: number
}

/** Bounds memory during a long probe run; percentiles only need a rolling window. */
const MAX_SAMPLES = 2000

export type MainThreadBlockingWatch = {
  stop: () => void
  census: () => MainThreadBlockingCensus
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0
  }
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  return sorted[index] ?? 0
}

function emptyCensus(windowMs: number, supported: boolean): MainThreadBlockingCensus {
  return {
    supported,
    windowMs: Math.round(windowMs),
    taskCount: 0,
    blockedMs: 0,
    blockedPercent: 0,
    longestTaskMs: 0,
    p50TaskMs: 0,
    p95TaskMs: 0
  }
}

/**
 * Observes long tasks (>50ms) until `stop()`. `census()` summarizes everything
 * seen since the call. Safe on engines without the longtask entry type:
 * `supported` reports false and every count stays zero rather than throwing.
 */
export function watchMainThreadBlocking(): MainThreadBlockingWatch {
  const samples: LongTaskSample[] = []
  const startedAt = typeof performance === 'undefined' ? 0 : performance.now()
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        samples.push({ durationMs: entry.duration, startedAt: entry.startTime })
        if (samples.length > MAX_SAMPLES) {
          samples.shift()
        }
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    observer = null
  }
  const supported = observer !== null
  return {
    stop: () => {
      observer?.disconnect()
      observer = null
    },
    census: () => {
      const now = typeof performance === 'undefined' ? startedAt : performance.now()
      const windowMs = Math.max(1, now - startedAt)
      if (samples.length === 0) {
        return emptyCensus(windowMs, supported)
      }
      const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b)
      const blockedMs = durations.reduce((sum, value) => sum + value, 0)
      return {
        supported,
        windowMs: Math.round(windowMs),
        taskCount: samples.length,
        blockedMs: Math.round(blockedMs),
        blockedPercent: Math.round((blockedMs / windowMs) * 100),
        longestTaskMs: Math.round(durations.at(-1) ?? 0),
        p50TaskMs: Math.round(percentile(durations, 0.5)),
        p95TaskMs: Math.round(percentile(durations, 0.95))
      }
    }
  }
}
