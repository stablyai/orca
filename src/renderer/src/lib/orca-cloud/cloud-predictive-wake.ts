// Predictive wake: start waking a sleeping Orca Cloud workspace on intent (a hover that dwells,
// keyboard focus on its row, the window coming back while it is the active one) so the sandbox is
// already booting when the click lands. A predictive wake is silent: a refusal (seat cap, plan)
// shows nothing, and it never counts as use — a workspace nobody opens goes back to sleep after
// the normal idle window. It never runs on app launch, on archived workspaces, or right after a
// sleep. The user's own open takes over the wake (single-flight in main) and shows its progress.

export type PredictiveWakeTrigger = 'hover' | 'select' | 'focus'

export type PredictiveWakeDeps = {
  now: () => number
  /** The setting (default on). */
  isEnabled: () => boolean
  /** Cloud, known asleep (not archived, not already waking). */
  isWakeCandidate: (workspaceId: string) => boolean
  /** Starts the ordinary wake; resolves when it settles. Errors are swallowed by the caller. */
  wake: (workspaceId: string) => Promise<unknown>
  /** Schedules `run`; returns a cancel function. */
  setTimer: (run: () => void, ms: number) => () => void
}

export const HOVER_DWELL_MS = 400
export const SELECT_DEBOUNCE_MS = 150
/** A workspace slept (by the user or idle) is not woken by intent for this long. */
export const SLEEP_COOLDOWN_MS = 120_000
/** Hover is the weakest signal: at most one hover-started wake per this window. */
export const HOVER_MIN_GAP_MS = 30_000
export const MAX_CONCURRENT_PREDICTIVE_WAKES = 2

export type PredictiveWakeController = {
  hoverStart: (workspaceId: string) => void
  hoverEnd: (workspaceId: string) => void
  select: (workspaceId: string) => void
  windowBlur: () => void
  windowFocus: (activeWorkspaceId: string | null) => void
  noteSlept: (workspaceId: string) => void
  /** The user opened it: its wake is no longer silent. */
  claim: (workspaceId: string) => void
  isSilent: (workspaceId: string) => boolean
  /** Test seam. */
  inFlight: () => ReadonlySet<string>
  dispose: () => void
}

export function createPredictiveWakeController(deps: PredictiveWakeDeps): PredictiveWakeController {
  const sleptAt = new Map<string, number>()
  const running = new Set<string>()
  const silent = new Set<string>()
  const pending = new Map<string, () => void>()
  let lastHoverWakeAt = Number.NEGATIVE_INFINITY
  // Why: the first focus after launch is the app opening, not someone coming back to it.
  let blurredSinceLaunch = false

  const cancelPending = (workspaceId: string): void => {
    const cancel = pending.get(workspaceId)
    if (cancel) {
      cancel()
      pending.delete(workspaceId)
    }
  }

  const eligible = (workspaceId: string): boolean => {
    if (!deps.isEnabled() || running.has(workspaceId)) {
      return false
    }
    if (running.size >= MAX_CONCURRENT_PREDICTIVE_WAKES) {
      return false
    }
    const slept = sleptAt.get(workspaceId)
    if (slept !== undefined && deps.now() - slept < SLEEP_COOLDOWN_MS) {
      return false
    }
    return deps.isWakeCandidate(workspaceId)
  }

  const fire = (workspaceId: string, trigger: PredictiveWakeTrigger): void => {
    pending.delete(workspaceId)
    if (!eligible(workspaceId)) {
      return
    }
    if (trigger === 'hover') {
      if (deps.now() - lastHoverWakeAt < HOVER_MIN_GAP_MS) {
        return
      }
      lastHoverWakeAt = deps.now()
    }
    running.add(workspaceId)
    silent.add(workspaceId)
    void Promise.resolve()
      .then(() => deps.wake(workspaceId))
      .catch(() => undefined)
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
    select: (workspaceId) => schedule(workspaceId, 'select', SELECT_DEBOUNCE_MS),
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
      sleptAt.set(workspaceId, deps.now())
    },
    claim: (workspaceId) => {
      cancelPending(workspaceId)
      silent.delete(workspaceId)
    },
    isSilent: (workspaceId) => silent.has(workspaceId),
    inFlight: () => running,
    dispose: () => {
      for (const workspaceId of Array.from(pending.keys())) {
        cancelPending(workspaceId)
      }
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
