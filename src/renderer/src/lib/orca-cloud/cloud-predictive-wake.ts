// Predictive wake: start waking a sleeping Orca Cloud workspace on intent (a hover that dwells, a
// press on its row, the window coming back while it is the active one) so the sandbox is already
// booting when the click lands. Bounded so intent can't run up sandbox hours or a seat cap: at most
// two sandboxes woken on intent and not yet opened at any time, each put back to sleep after a few
// minutes unless opened; weak signals (hover, focus) share one rate limit; a refusal (seat cap,
// plan) is silent and backs off. It never runs on app launch, on archived workspaces, right after
// a sleep, or (for focus) on a workspace the user slept until they act on it again. Opening the
// workspace claims the wake (single-flight in main) and shows its progress.

export type PredictiveWakeTrigger = 'hover' | 'select' | 'focus'

export type PredictiveWakeDeps = {
  now: () => number
  /** The setting (default on). */
  isEnabled: () => boolean
  /** Cloud, known asleep (not archived, not already waking). */
  isWakeCandidate: (workspaceId: string) => boolean
  /** Starts the ordinary wake quietly; resolves true when the sandbox woke, false when refused. */
  wake: (workspaceId: string) => Promise<boolean>
  /** Puts a woken-but-never-opened workspace back to sleep. */
  sleep: (workspaceId: string) => Promise<unknown>
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
/** A sandbox woken on intent that nobody opened goes back to sleep after this. */
export const UNOPENED_SLEEP_MS = 3 * 60_000
/** After a refusal (seat cap, plan) intent leaves the workspace alone for this long. */
export const REFUSAL_BACKOFF_MS = 10 * 60_000

export type PredictiveWakeController = {
  hoverStart: (workspaceId: string) => void
  hoverEnd: (workspaceId: string) => void
  select: (workspaceId: string) => void
  windowBlur: () => void
  windowFocus: (activeWorkspaceId: string | null) => void
  noteSlept: (workspaceId: string) => void
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
      deps.setTimer(() => {
        unopened.delete(workspaceId)
        void Promise.resolve()
          .then(() => deps.sleep(workspaceId))
          .catch(() => undefined)
      }, UNOPENED_SLEEP_MS)
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
    if (trigger !== 'select') {
      if (deps.now() - lastWeakWakeAt < WEAK_TRIGGER_MIN_GAP_MS) {
        return
      }
      lastWeakWakeAt = deps.now()
    }
    running.add(workspaceId)
    silent.add(workspaceId)
    void Promise.resolve()
      .then(() => deps.wake(workspaceId))
      .catch(() => false)
      .then((woke) => {
        const claimed = !silent.has(workspaceId)
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
    if (!deps.isEnabled()) {
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
    noteSlept: (workspaceId) => {
      cancelPending(workspaceId)
      unopened.get(workspaceId)?.()
      unopened.delete(workspaceId)
      sleptAt.set(workspaceId, deps.now())
      sleptNoFocus.add(workspaceId)
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
export function notePredictiveWakeSlept(workspaceId: string): void {
  current?.noteSlept(workspaceId)
}
export function claimPredictiveWake(workspaceId: string): void {
  current?.claim(workspaceId)
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
