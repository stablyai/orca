export type CoalescedPollRunner = {
  run: () => void
  dispose: () => void
}

export function createCoalescedPollRunner(
  task: () => Promise<void>,
  options?: { minIntervalMs?: number }
): CoalescedPollRunner {
  let disposed = false
  let inFlight = false
  let rerun = false
  let lastRunEndedAt = -Infinity
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const run = (): void => {
    if (disposed) {
      return
    }
    if (inFlight) {
      rerun = true
      return
    }
    if (timeoutId !== null) {
      return
    }

    const now = Date.now()
    const timeSinceLastEnd = now - lastRunEndedAt
    const minInterval = options?.minIntervalMs ?? 0
    if (timeSinceLastEnd < minInterval) {
      const delay = minInterval - timeSinceLastEnd
      timeoutId = setTimeout(() => {
        timeoutId = null
        run()
      }, delay)
      return
    }

    inFlight = true
    void task()
      .catch(() => {
        // Poll callers handle their own expected transient errors. A rejected
        // task must still release the in-flight latch and optional trailing run.
      })
      .finally(() => {
        inFlight = false
        lastRunEndedAt = Date.now()
        const shouldRerun = rerun && !disposed
        rerun = false
        if (shouldRerun) {
          run()
        }
      })
  }

  return {
    run,
    dispose: () => {
      disposed = true
      rerun = false
      if (timeoutId !== null) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    }
  }
}
