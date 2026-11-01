/** Bounds how often a throttled foreground repair runs: sustained output repaints its own dirty rows in between. */
export const FORCED_REFRESH_MIN_MS = 100

/** Only the terminal's identity matters here; its rows and refresh belong to the caller's repair. */
type ForcedRefreshTarget = WeakKey

type ForcedRefreshState = {
  lastRepairAt: number
  trailingTimer: ReturnType<typeof setTimeout> | null
  parsesInFlight: number
  repairOwed: boolean
  suppressedFollowupRefresh: boolean
}

const stateByTerminal = new WeakMap<ForcedRefreshTarget, ForcedRefreshState>()

/** Lazily create the per-terminal window state; absent means "no repair yet, nothing pending". */
function stateFor(terminal: ForcedRefreshTarget): ForcedRefreshState {
  let state = stateByTerminal.get(terminal)
  if (!state) {
    state = {
      lastRepairAt: Number.NEGATIVE_INFINITY,
      trailingTimer: null,
      parsesInFlight: 0,
      repairOwed: false,
      suppressedFollowupRefresh: false
    }
    stateByTerminal.set(terminal, state)
  }
  return state
}

/** One time base, so every window comparison measures the same clock. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Claim the repair slot for a repair about to run, or report that the window has not elapsed. */
export function takeForcedRefreshSlot(terminal: ForcedRefreshTarget): boolean {
  const state = stateFor(terminal)
  if (now() - state.lastRepairAt < FORCED_REFRESH_MIN_MS) {
    return false
  }
  state.lastRepairAt = now()
  cancelTrailingForcedRefresh(terminal)
  return true
}

/** Track a throttled parse from submission to callback, so a repair cannot run while rows are still arriving. */
export function noteForegroundParseStarted(terminal: ForcedRefreshTarget): void {
  stateFor(terminal).parsesInFlight += 1
}

/** Returns true once the last tracked parse has landed, so a repair can no longer run mid-backlog. */
export function noteForegroundParseLanded(terminal: ForcedRefreshTarget): boolean {
  const state = stateFor(terminal)
  state.parsesInFlight = Math.max(0, state.parsesInFlight - 1)
  return state.parsesInFlight === 0
}

export function hasForegroundParseInFlight(terminal: ForcedRefreshTarget): boolean {
  return (stateByTerminal.get(terminal)?.parsesInFlight ?? 0) > 0
}

/** Remember a suppressed repair: the next-frame repaint it asked for, and the rows it is owed. */
export function noteSuppressedRepair(
  terminal: ForcedRefreshTarget,
  options: { followupViewportRefresh?: boolean }
): void {
  const state = stateFor(terminal)
  state.repairOwed = true
  if (options.followupViewportRefresh) {
    state.suppressedFollowupRefresh = true
  }
}

/** True while a suppressed batch is still owed a repair — even after a slot claim cancelled its trailing timer. */
export function isSuppressedRepairOwed(terminal: ForcedRefreshTarget): boolean {
  return stateByTerminal.get(terminal)?.repairOwed === true
}

/** Clear the obligation only once a repair has covered those rows and no parse can still add more. */
export function markSuppressedRepairCovered(terminal: ForcedRefreshTarget): void {
  const state = stateByTerminal.get(terminal)
  if (state && state.parsesInFlight === 0) {
    state.repairOwed = false
  }
}

/** Take the follow-up a suppressed repair asked for; the repair that lands owns it. */
export function consumeSuppressedFollowupRefresh(terminal: ForcedRefreshTarget): boolean {
  const state = stateFor(terminal)
  const pending = state.suppressedFollowupRefresh
  state.suppressedFollowupRefresh = false
  return pending
}

/** Run `repair` once the window elapses and no tracked parse is still in flight. */
export function armTrailingForcedRefresh(terminal: ForcedRefreshTarget, repair: () => void): void {
  const state = stateFor(terminal)
  if (state.trailingTimer !== null) {
    return
  }
  const timer = setTimeout(() => {
    state.trailingTimer = null
    if (state.parsesInFlight > 0) {
      // A repair taken mid-parse cannot cover rows that parse has not reached; its own callback arms again.
      return
    }
    state.lastRepairAt = now()
    repair()
  }, FORCED_REFRESH_MIN_MS)
  timer.unref?.()
  state.trailingTimer = timer
}

/** Drop a pending trailing repair once no parse can still dirty rows; the completed repair already covers them. */
export function cancelTrailingForcedRefreshWhenIdle(terminal: ForcedRefreshTarget): void {
  const state = stateByTerminal.get(terminal)
  if (!state || state.parsesInFlight > 0) {
    return
  }
  cancelTrailingForcedRefresh(terminal)
}

/** Drop a pending trailing repair; a live repair is about to own those rows. */
export function cancelTrailingForcedRefresh(terminal: ForcedRefreshTarget): void {
  const state = stateByTerminal.get(terminal)
  if (!state || state.trailingTimer === null) {
    return
  }
  clearTimeout(state.trailingTimer)
  state.trailingTimer = null
}

export function discardForcedRefreshWindow(terminal: ForcedRefreshTarget): void {
  cancelTrailingForcedRefresh(terminal)
  stateByTerminal.delete(terminal)
}
