// Predictive wake: start waking a sleeping Orca Cloud workspace on intent (a hover that dwells, a
// press on its row, the window coming back while it is the active one) so the sandbox is already
// booting when the click lands. Bounded so intent can't run up sandbox hours or a seat cap: at most
// two sandboxes woken on intent and not yet opened at any time; main gives those a short idle
// window, sleeping them only when their server reports no work, unless they are opened (any
// activation claims them); weak signals (hover, focus) share one rate limit; a refusal (seat cap,
// plan) is silent and backs off. It never runs on app launch, on archived workspaces, right after
// a sleep (from any client: the server reports the last one someone chose), with its owner's seat
// at or one below its running cap, during a drag, or (for focus) on a workspace the user slept
// until they act on it again. Opening the workspace claims the wake (single-flight in main) and
// shows its progress.

export type PredictiveWakeTrigger = 'hover' | 'select' | 'focus'

export type PredictiveWakeDeps = {
  now: () => number
  /** The setting (default on). */
  isEnabled: () => boolean
  /** Cloud, known asleep (not archived, not already waking). */
  isWakeCandidate: (workspaceId: string) => boolean
  /**
   * Fresh server checks just before waking: false skips this wake quietly (no backoff), e.g. it was
   * slept on purpose from another client moments ago, or its owner's seat is at or near its cap.
   */
  preflight?: (workspaceId: string) => Promise<boolean>
  /**
   * Starts the ordinary wake quietly; resolves true when the sandbox woke, false when refused, and
   * 'skipped' when there was nothing to resume (it was already up): no wake, and no backoff.
   */
  wake: (workspaceId: string) => Promise<boolean | 'skipped'>
  /** Schedules `run`; returns a cancel function. */
  setTimer: (run: () => void, ms: number) => () => void
}

export const HOVER_DWELL_MS = 400
export const SELECT_DEBOUNCE_MS = 150
/** A workspace slept (by the user or idle) is not woken by intent for this long. */
export const SLEEP_COOLDOWN_MS = 120_000
/** Hover and focus are weak signals: at most one wake from either per this window. */
export const WEAK_TRIGGER_MIN_GAP_MS = 30_000
/** Sandboxes woken on intent and not opened (in flight or awake) at any one time. */
export const MAX_PREDICTIVE_AWAKE = 2
/** How long a sandbox woken on intent counts against the cap if nobody opens it (main puts it
 *  back to sleep on a short idle window, only when its server reports no work). */
export const UNOPENED_HOLD_MS = 3 * 60_000
/** After a refusal (seat cap, plan) intent leaves the workspace alone for this long. */
export const REFUSAL_BACKOFF_MS = 10 * 60_000

export type PredictiveWakeController = {
  hoverStart: (workspaceId: string) => void
  hoverEnd: (workspaceId: string) => void
  select: (workspaceId: string) => void
  windowBlur: () => void
  windowFocus: (activeWorkspaceId: string | null) => void
  /** A drag began: nothing pending fires, and nothing new is armed until it ends. */
  dragStart: () => void
  dragEnd: () => void
  noteSlept: (workspaceId: string) => void
  /** The sleep was the idle timer, not the user: coming back to Orca may wake it again. */
  noteIdleSlept: (workspaceId: string) => void
  /** The user opened it: its wake is no longer silent, and it is no longer put back to sleep. */
  claim: (workspaceId: string) => void
  isSilent: (workspaceId: string) => boolean
  /** Test seams. */
  inFlight: () => ReadonlySet<string>
  awakeUnopened: () => ReadonlySet<string>
  dispose: () => void
}

export function createPredictiveWakeController(deps: PredictiveWakeDeps): PredictiveWakeController {
  const sleptAt = new Map<string, number>()
  // Slept by the user (or idle): focus never re-wakes these until the user acts on them again.
  const sleptNoFocus = new Set<string>()
  const refusedUntil = new Map<string, number>()
  const running = new Set<string>()
  const silent = new Set<string>()
  // Woken on intent, not opened yet: each holds its return-to-sleep timer.
  const unopened = new Map<string, () => void>()
  const pending = new Map<string, () => void>()
  let lastWeakWakeAt = Number.NEGATIVE_INFINITY
  let dragging = false
  // Why: the first focus after launch is the app opening, not someone coming back to it.
  let blurredSinceLaunch = false

  const cancelPending = (workspaceId: string): void => {
    pending.get(workspaceId)?.()
    pending.delete(workspaceId)
  }

  const eligible = (workspaceId: string): boolean => {
    if (!deps.isEnabled() || running.has(workspaceId) || unopened.has(workspaceId)) {
      return false
    }
    if (running.size + unopened.size >= MAX_PREDICTIVE_AWAKE) {
      return false
    }
    const now = deps.now()
    const slept = sleptAt.get(workspaceId)
    if (slept !== undefined && now - slept < SLEEP_COOLDOWN_MS) {
      return false
    }
    if ((refusedUntil.get(workspaceId) ?? 0) > now) {
      return false
    }
    return deps.isWakeCandidate(workspaceId)
  }

  const keepUnopened = (workspaceId: string): void => {
    unopened.set(
      workspaceId,
      deps.setTimer(() => unopened.delete(workspaceId), UNOPENED_HOLD_MS)
    )
  }

  const fire = (workspaceId: string, trigger: PredictiveWakeTrigger): void => {
    pending.delete(workspaceId)
    if (!eligible(workspaceId)) {
      return
    }
    if (trigger === 'focus' && sleptNoFocus.has(workspaceId)) {
      return
    }
    // A wake that turns out skipped never happened, so it gives the hover/focus gap back.
    const previousWeakWakeAt = lastWeakWakeAt
    if (trigger !== 'select') {
      if (deps.now() - lastWeakWakeAt < WEAK_TRIGGER_MIN_GAP_MS) {
        return
      }
      lastWeakWakeAt = deps.now()
    }
    const thisWeakWakeAt = lastWeakWakeAt
    running.add(workspaceId)
    silent.add(workspaceId)
    void Promise.resolve()
      .then(async () => {
        if (deps.preflight && !(await deps.preflight(workspaceId).catch(() => false))) {
          return 'skipped' as const
        }
        return deps.wake(workspaceId)
      })
      .catch(() => false)
      .then((woke) => {
        const claimed = !silent.has(workspaceId)
        if (woke === 'skipped') {
          // Unless a later wake took the gap since.
          if (trigger !== 'select' && lastWeakWakeAt === thisWeakWakeAt) {
            lastWeakWakeAt = previousWeakWakeAt
          }
          return
        }
        if (!woke) {
          refusedUntil.set(workspaceId, deps.now() + REFUSAL_BACKOFF_MS)
        } else if (!claimed) {
          keepUnopened(workspaceId)
        }
      })
      .finally(() => {
        running.delete(workspaceId)
        silent.delete(workspaceId)
      })
  }

  const schedule = (workspaceId: string, trigger: PredictiveWakeTrigger, ms: number): void => {
    cancelPending(workspaceId)
    if (!deps.isEnabled() || dragging) {
      return
    }
    pending.set(
      workspaceId,
      deps.setTimer(() => fire(workspaceId, trigger), ms)
    )
  }

  return {
    hoverStart: (workspaceId) => schedule(workspaceId, 'hover', HOVER_DWELL_MS),
    hoverEnd: (workspaceId) => cancelPending(workspaceId),
    select: (workspaceId) => {
      sleptNoFocus.delete(workspaceId)
      schedule(workspaceId, 'select', SELECT_DEBOUNCE_MS)
    },
    windowBlur: () => {
      blurredSinceLaunch = true
    },
    windowFocus: (activeWorkspaceId) => {
      if (!blurredSinceLaunch || !activeWorkspaceId) {
        return
      }
      schedule(activeWorkspaceId, 'focus', SELECT_DEBOUNCE_MS)
    },
    dragStart: () => {
      dragging = true
      for (const workspaceId of Array.from(pending.keys())) {
        cancelPending(workspaceId)
      }
    },
    dragEnd: () => {
      dragging = false
    },
    noteSlept: (workspaceId) => {
      cancelPending(workspaceId)
      unopened.get(workspaceId)?.()
      unopened.delete(workspaceId)
      sleptAt.set(workspaceId, deps.now())
      sleptNoFocus.add(workspaceId)
    },
    noteIdleSlept: (workspaceId) => {
      sleptNoFocus.delete(workspaceId)
    },
    claim: (workspaceId) => {
      cancelPending(workspaceId)
      silent.delete(workspaceId)
      sleptNoFocus.delete(workspaceId)
      refusedUntil.delete(workspaceId)
      unopened.get(workspaceId)?.()
      unopened.delete(workspaceId)
    },
    isSilent: (workspaceId) => silent.has(workspaceId),
    inFlight: () => running,
    awakeUnopened: () => new Set(unopened.keys()),
    dispose: () => {
      for (const workspaceId of Array.from(pending.keys())) {
        cancelPending(workspaceId)
      }
      for (const cancel of unopened.values()) {
        cancel()
      }
      unopened.clear()
    }
  }
}

let current: PredictiveWakeController | null = null

export function setPredictiveWakeController(next: PredictiveWakeController | null): void {
  current?.dispose()
  current = next
}

// Thin call sites for the sidebar, sleep flow and activation; no-ops until installed.
export function notePredictiveWakeHoverStart(workspaceId: string): void {
  current?.hoverStart(workspaceId)
}
export function notePredictiveWakeHoverEnd(workspaceId: string): void {
  current?.hoverEnd(workspaceId)
}
export function notePredictiveWakeSelect(workspaceId: string): void {
  current?.select(workspaceId)
}
export function notePredictiveWakeDragStart(): void {
  current?.dragStart()
}
export function notePredictiveWakeDragEnd(): void {
  current?.dragEnd()
}
export function notePredictiveWakeSlept(workspaceId: string): void {
  current?.noteSlept(workspaceId)
}
export function notePredictiveWakeIdleSlept(workspaceId: string): void {
  current?.noteIdleSlept(workspaceId)
}
export function claimPredictiveWake(workspaceId: string): void {
  current?.claim(workspaceId)
}
/** A wake started on intent is in flight, or woke the VM and nobody opened it yet. */
export function isPredictiveWakeOutstanding(workspaceId: string): boolean {
  return Boolean(
    current && (current.isSilent(workspaceId) || current.awakeUnopened().has(workspaceId))
  )
}
export function isSilentPredictiveWake(workspaceId: string): boolean {
  return current?.isSilent(workspaceId) ?? false
}
export function notePredictiveWakeWindowFocus(activeWorkspaceId: string | null): void {
  current?.windowFocus(activeWorkspaceId)
}
export function notePredictiveWakeWindowBlur(): void {
  current?.windowBlur()
}
