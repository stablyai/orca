import { slowTaskRequiredIdleMs, type SlowTaskBackoffOptions } from './coalesced-poll-runner'

export type GitStatusRefreshReason = 'activity' | 'safety'

export type GitStatusRefreshScheduler = {
  resumeSafety: () => void
  pause: () => void
  suspendSafety: () => void
  signal: () => void
  refreshNow: () => void
  dispose: () => void
}

type RefreshTask = (request: {
  reason: GitStatusRefreshReason
  signal: AbortSignal
}) => Promise<void>

export function createGitStatusRefreshScheduler(
  task: RefreshTask,
  options: {
    safetyIntervalMs: number
    activityDebounceMs: number
    // Why: sustained signal streams (busy agent terminals, file churn) must
    // never run status scans back-to-back (#7983). Activity runs keep this
    // minimum idle gap since the previous run's end, scaled up by the slow
    // task backoff when the previous scan itself was slow.
    activityMinGapMs: number
    slowTaskBackoff: SlowTaskBackoffOptions
  }
): GitStatusRefreshScheduler {
  let disposed = false
  let safetyEnabled = false
  let inFlight = false
  let pendingActivity = false
  let activityTimer: ReturnType<typeof setTimeout> | null = null
  let activityTimerFiresAt = Infinity
  let safetyTimer: ReturnType<typeof setTimeout> | null = null
  let activeController: AbortController | null = null
  let lastRunEndedAt = -Infinity
  let lastRunDurationMs = 0

  const clearActivityTimer = (): void => {
    if (activityTimer !== null) {
      clearTimeout(activityTimer)
      activityTimer = null
      activityTimerFiresAt = Infinity
    }
  }
  const clearSafetyTimer = (): void => {
    if (safetyTimer !== null) {
      clearTimeout(safetyTimer)
      safetyTimer = null
    }
  }

  const requiredActivityIdleMs = (): number =>
    slowTaskRequiredIdleMs(
      lastRunDurationMs,
      options.slowTaskBackoff.changeSignalMultiplier,
      options.activityMinGapMs,
      options.slowTaskBackoff.maxIntervalMs
    )

  const scheduleSafetyRun = (): void => {
    // Why: slow scans stretch the safety horizon (idle-lane backoff) so a
    // tens-of-seconds status scan never approaches a continuous git duty cycle.
    const delay = Math.max(
      options.safetyIntervalMs,
      slowTaskRequiredIdleMs(
        lastRunDurationMs,
        options.slowTaskBackoff.idleMultiplier,
        0,
        options.slowTaskBackoff.maxIntervalMs
      )
    )
    safetyTimer = setTimeout(() => {
      safetyTimer = null
      startRun('safety')
    }, delay)
  }

  const scheduleActivityRun = (minDelayMs: number): void => {
    if (disposed) {
      return
    }
    if (inFlight) {
      // Why: the trigger may describe a mutation after the running Git
      // snapshot, so one trailing refresh is required for freshness.
      pendingActivity = true
      return
    }
    const now = Date.now()
    const delay = Math.max(minDelayMs, lastRunEndedAt + requiredActivityIdleMs() - now)
    if (delay <= 0) {
      startRun('activity')
      return
    }
    const firesAt = now + delay
    if (activityTimer !== null) {
      // Why: an earlier-eligible trigger may pull a pending run forward, but a
      // later debounce window must never push an already-scheduled run back.
      if (firesAt >= activityTimerFiresAt) {
        return
      }
      clearActivityTimer()
    }
    activityTimerFiresAt = firesAt
    activityTimer = setTimeout(() => {
      activityTimer = null
      activityTimerFiresAt = Infinity
      startRun('activity')
    }, delay)
  }

  const startRun = (reason: GitStatusRefreshReason): void => {
    if (disposed || inFlight) {
      return
    }
    clearActivityTimer()
    clearSafetyTimer()
    inFlight = true
    const startedAt = Date.now()
    const controller = new AbortController()
    activeController = controller
    let result: Promise<void>
    try {
      result = task({ reason, signal: controller.signal })
    } catch (error) {
      result = Promise.reject(error)
    }
    void result
      .catch(() => {
        // Status refresh errors are transient; the next signal or safety run retries.
      })
      .finally(() => {
        lastRunEndedAt = Date.now()
        // Why: cancelled scans never delivered a useful result, so their wall
        // time must not stretch the next activity/safety gap. Otherwise hide →
        // reveal after a slow abort waits out the aborted scan's full duration
        // before the catch-up refresh can start.
        lastRunDurationMs = controller.signal.aborted ? 0 : Math.max(0, lastRunEndedAt - startedAt)
        if (activeController === controller) {
          activeController = null
        }
        inFlight = false
        if (disposed) {
          return
        }
        if (pendingActivity) {
          pendingActivity = false
          scheduleActivityRun(0)
          return
        }
        if (safetyEnabled) {
          scheduleSafetyRun()
        }
      })
  }

  return {
    resumeSafety: () => {
      if (disposed) {
        return
      }
      const wasEnabled = safetyEnabled
      safetyEnabled = true
      if (wasEnabled) {
        return
      }
      clearSafetyTimer()
      if (inFlight) {
        // Why: a request aborted while hidden cannot serve as reveal catch-up;
        // retain one fresh run and wait for the old transport to settle.
        pendingActivity ||= activeController?.signal.aborted === true
        return
      }
      scheduleActivityRun(0)
    },
    pause: () => {
      safetyEnabled = false
      pendingActivity = false
      clearActivityTimer()
      clearSafetyTimer()
      activeController?.abort()
    },
    suspendSafety: () => {
      safetyEnabled = false
      clearSafetyTimer()
    },
    signal: () => {
      if (disposed) {
        return
      }
      clearSafetyTimer()
      scheduleActivityRun(options.activityDebounceMs)
    },
    refreshNow: () => {
      if (disposed) {
        return
      }
      clearSafetyTimer()
      scheduleActivityRun(0)
    },
    dispose: () => {
      disposed = true
      safetyEnabled = false
      pendingActivity = false
      clearActivityTimer()
      clearSafetyTimer()
      activeController?.abort()
    }
  }
}
