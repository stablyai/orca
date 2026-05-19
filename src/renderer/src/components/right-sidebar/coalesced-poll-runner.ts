export type CoalescedPollRunner = {
  run: () => void
  dispose: () => void
}

export function createCoalescedPollRunner(task: () => Promise<void>): CoalescedPollRunner {
  let disposed = false
  let inFlight = false
  let rerun = false

  const run = (): void => {
    if (disposed) {
      return
    }
    if (inFlight) {
      rerun = true
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
        if (rerun && !disposed) {
          rerun = false
          run()
          return
        }
        rerun = false
      })
  }

  return {
    run,
    dispose: () => {
      disposed = true
      rerun = false
    }
  }
}
