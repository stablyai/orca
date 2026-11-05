export type CoalescedPollRunnerTrigger = {
  // Evidence of a real change (watch/push/command), which gets shorter backoff than timer ticks.
  changeSignal?: boolean
}

export type CoalescedPollRunner = {
  run: (trigger?: CoalescedPollRunnerTrigger) => void
  dispose: () => void
}

export type SlowTaskBackoffOptions = {
  // Required idle time as a multiple of the previous duration for timer ticks.
  idleMultiplier: number
  // Shorter change-signal idle time keeps slow repos responsive without allowing back-to-back runs.
  changeSignalMultiplier: number
  maxIntervalMs: number
}

// Scale idle time with slow runs to prevent continuous polling (#7983); signals wait less than ticks, with a staleness cap.
export function slowTaskRequiredIdleMs(
  lastRunDurationMs: number,
  multiplier: number,
  minIntervalMs: number,
  maxIntervalMs: number
): number {
  return Math.max(minIntervalMs, Math.min(lastRunDurationMs * multiplier, maxIntervalMs))
}

export function createCoalescedPollRunner(
  task: () => Promise<void>,
  options?: {
    minIntervalMs?: number
    slowTaskBackoff?: SlowTaskBackoffOptions
  }
): CoalescedPollRunner {
  let disposed = false
  let inFlight = false
  let rerunTrigger: CoalescedPollRunnerTrigger | null = null
  let lastRunEndedAt = -Infinity
  let lastRunDurationMs = 0
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timeoutFiresAt = Infinity
  const minIntervalMs = options?.minIntervalMs ?? 0

  const requiredIdleMsFor = (trigger?: CoalescedPollRunnerTrigger): number => {
    const backoff = options?.slowTaskBackoff
    if (!backoff) {
      return minIntervalMs
    }
    const multiplier = trigger?.changeSignal
      ? backoff.changeSignalMultiplier
      : backoff.idleMultiplier
    return slowTaskRequiredIdleMs(
      lastRunDurationMs,
      multiplier,
      minIntervalMs,
      backoff.maxIntervalMs
    )
  }

  const clearScheduledRun = (): void => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
      timeoutFiresAt = Infinity
    }
  }

  const run = (trigger?: CoalescedPollRunnerTrigger): void => {
    if (disposed) {
      return
    }
    if (inFlight) {
      // Preserve the strongest pending trigger so later ticks cannot downgrade a change signal.
      rerunTrigger = { changeSignal: rerunTrigger?.changeSignal || trigger?.changeSignal }
      return
    }

    const now = Date.now()
    const allowedAt = lastRunEndedAt + requiredIdleMsFor(trigger)
    if (now < allowedAt) {
      // Signals may advance a scheduled tick; weaker triggers must never delay a scheduled run.
      if (allowedAt >= timeoutFiresAt) {
        return
      }
      clearScheduledRun()
      timeoutFiresAt = allowedAt
      timeoutId = setTimeout(() => {
        timeoutId = null
        timeoutFiresAt = Infinity
        run(trigger)
      }, allowedAt - now)
      return
    }

    clearScheduledRun()
    inFlight = true
    void task()
      .catch(() => {
        // Callers handle transient errors; rejection must still release the latch and allow trailing work.
      })
      .finally(() => {
        inFlight = false
        lastRunEndedAt = Date.now()
        lastRunDurationMs = lastRunEndedAt - now
        const trailingTrigger = disposed ? null : rerunTrigger
        rerunTrigger = null
        if (trailingTrigger) {
          run(trailingTrigger)
        }
      })
  }

  return {
    run,
    dispose: () => {
      disposed = true
      rerunTrigger = null
      clearScheduledRun()
    }
  }
}
