export type CoalescedPollRunnerTrigger = {
  // True when the caller has evidence something changed (file-watch event,
  // repo metadata push signal, finished terminal command) rather than a bare
  // timer tick. Change signals wait out a shorter slow-task backoff.
  changeSignal?: boolean
}

export type CoalescedPollRunner = {
  run: (trigger?: CoalescedPollRunnerTrigger) => void
  dispose: () => void
}

export type SlowTaskBackoffOptions = {
  // Idle gap before an evidence-free timer tick may re-run, as a multiple of
  // the previous run's duration.
  idleMultiplier: number
  // Idle gap before a change-signal run may re-run. Kept low so slow repos
  // still refresh promptly after real changes, while sustained churn can
  // never keep the task running back-to-back.
  changeSignalMultiplier: number
  maxIntervalMs: number
}

// Why: on large monorepos a poll task (git status) can take tens of seconds,
// so a fixed idle gap makes polling effectively continuous (#7983). Scale the
// gap with the previous run's duration — aggressively for evidence-free timer
// ticks, mildly for change signals — capped so results never go minutes-stale.
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
    return Math.max(minIntervalMs, Math.min(lastRunDurationMs * multiplier, backoff.maxIntervalMs))
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
      // Why: keep the strongest pending trigger so a change signal arriving
      // mid-run is not downgraded to tick pacing by a later timer tick.
      rerunTrigger = { changeSignal: rerunTrigger?.changeSignal || trigger?.changeSignal }
      return
    }

    const now = Date.now()
    const allowedAt = lastRunEndedAt + requiredIdleMsFor(trigger)
    if (now < allowedAt) {
      // Why: a change signal may pull an already-scheduled evidence-free run
      // earlier; a weaker trigger must never push a scheduled run later.
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
        // Poll callers handle their own expected transient errors. A rejected
        // task must still release the in-flight latch and optional trailing run.
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
