import {
  slowTaskRequiredIdleMs,
  type SlowTaskBackoffOptions
} from '../../../../lib/repository-refresh/coalesced-poll-runner'

export type GitStatusRefreshReason = 'activity' | 'safety'

export function admissionTierForGitStatusRefreshReason(
  reason: GitStatusRefreshReason
): 'status' | 'background' {
  return reason === 'safety' ? 'background' : 'status'
}

// Share pacing across scheduler rebuilds so host/target changes cannot bypass the activity floor (#7983).
export type GitStatusRefreshPacing = {
  lastRunEndedAt: number
  lastRunDurationMs: number
  nextRunId: number
  latestFinishedRunId: number
}

export function createGitStatusRefreshPacing(): GitStatusRefreshPacing {
  return {
    lastRunEndedAt: -Infinity,
    lastRunDurationMs: 0,
    nextRunId: 0,
    latestFinishedRunId: 0
  }
}

export type GitStatusRefreshScheduler = {
  resumeSafety: () => void
  pause: () => void
  suspendSafety: () => void
  signal: () => void
  refreshNow: () => void
  // Re-derive pending timers from the current cadence; may only advance them (e.g. on window focus).
  retime: () => void
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
    // Enforce idle gaps after runs, scaled for slow scans, so sustained signals cannot run Git continuously (#7983).
    activityMinGapMs: number
    slowTaskBackoff: SlowTaskBackoffOptions
    pacing?: GitStatusRefreshPacing
    // Multiplies the activity floor and safety interval at schedule time (e.g. while unfocused).
    cadenceScale?: () => number
  }
): GitStatusRefreshScheduler {
  let disposed = false
  let safetyEnabled = false
  let inFlight = false
  let pendingActivity = false
  let activityTimer: ReturnType<typeof setTimeout> | null = null
  let activityTimerFiresAt = Infinity
  let safetyTimer: ReturnType<typeof setTimeout> | null = null
  let safetyTimerFiresAt = Infinity
  let activeController: AbortController | null = null
  const pacing = options.pacing ?? createGitStatusRefreshPacing()

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
      safetyTimerFiresAt = Infinity
    }
  }

  const cadenceScale = (): number => options.cadenceScale?.() ?? 1

  const requiredActivityIdleMs = (): number =>
    slowTaskRequiredIdleMs(
      pacing.lastRunDurationMs,
      options.slowTaskBackoff.changeSignalMultiplier,
      options.activityMinGapMs * cadenceScale(),
      options.slowTaskBackoff.maxIntervalMs
    )

  // Scale safety idle time after slow scans to prevent effectively continuous Git polling.
  const safetyDelayMs = (): number =>
    Math.max(
      options.safetyIntervalMs * cadenceScale(),
      slowTaskRequiredIdleMs(
        pacing.lastRunDurationMs,
        options.slowTaskBackoff.idleMultiplier,
        0,
        options.slowTaskBackoff.maxIntervalMs
      )
    )

  const scheduleSafetyRunAt = (firesAt: number): void => {
    clearSafetyTimer()
    safetyTimerFiresAt = firesAt
    safetyTimer = setTimeout(
      () => {
        safetyTimer = null
        safetyTimerFiresAt = Infinity
        startRun('safety')
      },
      Math.max(0, firesAt - Date.now())
    )
  }

  const scheduleActivityRun = (minDelayMs: number): void => {
    if (disposed) {
      return
    }
    if (inFlight) {
      // A mid-run trigger may postdate its snapshot; retain one trailing refresh.
      pendingActivity = true
      return
    }
    const now = Date.now()
    const delay = Math.max(minDelayMs, pacing.lastRunEndedAt + requiredActivityIdleMs() - now)
    if (delay <= 0) {
      startRun('activity')
      return
    }
    const firesAt = now + delay
    if (activityTimer !== null) {
      // Earlier triggers may advance a scheduled run; later debounce windows must never delay it.
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
    const runId = ++pacing.nextRunId
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
        if (runId > pacing.latestFinishedRunId) {
          pacing.latestFinishedRunId = runId
          pacing.lastRunEndedAt = Date.now()
          // Ignore aborted duration when pacing reveal catch-up; those scans never delivered useful results.
          pacing.lastRunDurationMs = controller.signal.aborted
            ? 0
            : Math.max(0, pacing.lastRunEndedAt - startedAt)
        }
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
          scheduleSafetyRunAt(Date.now() + safetyDelayMs())
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
        // Hidden aborted requests cannot serve reveal catch-up; queue fresh work after transport settles.
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
    retime: () => {
      if (disposed || inFlight) {
        return
      }
      if (activityTimer !== null) {
        // Keep the debounce: focus also fires when leaving a webview in an already-focused window.
        scheduleActivityRun(options.activityDebounceMs)
        return
      }
      const safetyFiresAt = pacing.lastRunEndedAt + safetyDelayMs()
      if (safetyTimer !== null && safetyFiresAt < safetyTimerFiresAt) {
        scheduleSafetyRunAt(safetyFiresAt)
      }
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
