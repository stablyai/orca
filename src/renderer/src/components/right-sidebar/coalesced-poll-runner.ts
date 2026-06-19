export type CoalescedPollRunner = {
  run: () => void
  dispose: () => void
}

export type CoalescedPollRunnerTimer = ReturnType<typeof setTimeout>

export type CoalescedPollRunnerOptions = {
  /**
   * Delay before a coalesced trailing run. Useful for expensive pollers whose
   * work can exceed the interval and would otherwise run back-to-back forever.
   */
  trailingDelayMs?: number
  setTimeoutFn?: (callback: () => void, delayMs: number) => CoalescedPollRunnerTimer
  clearTimeoutFn?: (handle: CoalescedPollRunnerTimer) => void
}

export function createCoalescedPollRunner(
  task: () => Promise<void>,
  options: CoalescedPollRunnerOptions = {}
): CoalescedPollRunner {
  let disposed = false
  let inFlight = false
  let rerun = false
  let trailingTimeout: CoalescedPollRunnerTimer | null = null
  const setTimeoutFn =
    options.setTimeoutFn ??
    ((callback: () => void, delayMs: number): CoalescedPollRunnerTimer =>
      setTimeout(callback, delayMs))
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((handle: CoalescedPollRunnerTimer): void => clearTimeout(handle))

  const clearTrailingTimeout = (): void => {
    if (!trailingTimeout) {
      return
    }
    clearTimeoutFn(trailingTimeout)
    trailingTimeout = null
  }

  const run = (): void => {
    if (disposed) {
      return
    }
    if (inFlight || trailingTimeout) {
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
          const delayMs = Math.max(0, options.trailingDelayMs ?? 0)
          if (delayMs > 0) {
            // Why: if a poll already exceeded its interval, immediate trailing
            // reruns can keep the renderer and IPC paths hot indefinitely.
            trailingTimeout = setTimeoutFn(() => {
              trailingTimeout = null
              // Consume the delayed rerun request before starting it; new ticks
              // during this run can still set rerun=true for one later pass.
              rerun = false
              run()
            }, delayMs)
            return
          }
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
      clearTrailingTimeout()
    }
  }
}
