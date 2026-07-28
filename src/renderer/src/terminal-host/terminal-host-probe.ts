// Latency probe for the isolated terminal host page. Mirrors the measurement
// core of renderer-churn-probe but tags lines `[terminal-host]` so diag logs
// can compare the host's input latency against the app renderer's under the
// same load. No store instrumentation — this page has no app store.

const REPORT_EVERY_MS = 5_000
const EVENT_DURATION_THRESHOLD_MS = 16

type ObserveOptions = PerformanceObserverInit & { durationThreshold?: number }

function observe(
  type: string,
  onEntries: (entries: PerformanceEntryList) => void,
  options: ObserveOptions = {}
): void {
  try {
    const observer = new PerformanceObserver((list) => onEntries(list.getEntries()))
    observer.observe({ type, buffered: true, ...options } as ObserveOptions)
  } catch {
    // Entry type unsupported in this Chromium build — skip that signal.
  }
}

export function startTerminalHostProbe(label: string): void {
  let longTaskCount = 0
  let longTaskMaxMs = 0
  let longTaskTotalMs = 0
  observe('longtask', (entries) => {
    for (const entry of entries) {
      longTaskCount++
      longTaskTotalMs += entry.duration
      if (entry.duration > longTaskMaxMs) {
        longTaskMaxMs = entry.duration
      }
    }
  })

  let inputCount = 0
  let inputMaxDelayMs = 0
  let inputMaxDurationMs = 0
  observe(
    'event',
    (entries) => {
      for (const entry of entries as PerformanceEventTiming[]) {
        inputCount++
        const delay = entry.processingStart - entry.startTime
        if (delay > inputMaxDelayMs) {
          inputMaxDelayMs = delay
        }
        if (entry.duration > inputMaxDurationMs) {
          inputMaxDurationMs = entry.duration
        }
      }
    },
    { durationThreshold: EVENT_DURATION_THRESHOLD_MS }
  )

  window.setInterval(() => {
    const report = {
      label,
      t: Math.round(performance.now()),
      longTasks: longTaskCount,
      longTaskMaxMs: Math.round(longTaskMaxMs),
      longTaskTotalMs: Math.round(longTaskTotalMs),
      inputs: inputCount,
      inputMaxDelayMs: Math.round(inputMaxDelayMs),
      inputMaxDurationMs: Math.round(inputMaxDurationMs)
    }
    longTaskCount = 0
    longTaskMaxMs = 0
    longTaskTotalMs = 0
    inputCount = 0
    inputMaxDelayMs = 0
    inputMaxDurationMs = 0
    // Forwarded to the diag log by main's console-message listener.
    console.info(`[terminal-host] ${JSON.stringify(report)}`)
  }, REPORT_EVERY_MS)
}
