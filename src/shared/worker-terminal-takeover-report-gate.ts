// Throttle one takeover per key and window: ordinary typing must not become one host transaction per key, but later dispatches can reuse the pane.
const REPORT_INTERVAL_MS = 30_000
const REPORT_GATE_PRUNE_SIZE = 256
const REPORT_RETRY_DELAY_MS = 250

/** Fire-and-forget; a failed report (after one retry) reopens its key so the next input reports again. */
export function reportWorkerTakeoverOncePerWindow(
  lastReportByKey: Map<string, number>,
  key: string,
  send: () => Promise<unknown>
): void {
  const now = Date.now()
  const last = lastReportByKey.get(key)
  if (last !== undefined && now - last < REPORT_INTERVAL_MS) {
    return
  }
  if (lastReportByKey.size >= REPORT_GATE_PRUNE_SIZE) {
    for (const [reportedKey, reportedAt] of lastReportByKey) {
      if (now - reportedAt >= REPORT_INTERVAL_MS) {
        lastReportByKey.delete(reportedKey)
      }
    }
  }
  lastReportByKey.set(key, now)
  void sendWithOneRetry(send).catch(() => {
    if (lastReportByKey.get(key) === now) {
      lastReportByKey.delete(key)
    }
  })
}

async function sendWithOneRetry(send: () => Promise<unknown>): Promise<void> {
  try {
    await send()
  } catch {
    await new Promise<void>((resolve) => setTimeout(resolve, REPORT_RETRY_DELAY_MS))
    await send()
  }
}
