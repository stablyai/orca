// The setup page hands the screen to the start screen. It used to close first and then let the
// hidden composer auto-start, so for a few frames the workspace underneath (a terminal) showed
// before "Starting your cloud workspace" did (Neil, build ff845fe). Now the page stays up until the
// create's own surface is active, or the composer goes away without one.

type HandoffState = { activePendingCreationId: string | null; activeModal: string }

export type HandoffDeps = {
  getState: () => HandoffState
  subscribe: (listener: (state: HandoffState) => void) => () => void
  closePage: () => void
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

/** The hidden composer reveals itself after 8 s; past that the dialog sits over the page anyway. */
export const SETUP_HANDOFF_MAX_MS = 10_000
const COMPOSER_MODAL = 'new-workspace-composer'

/** Call right after opening the auto-starting composer. Returns a cancel. */
export function closeSetupPageWhenCreateTakesOver(deps: HandoffDeps): () => void {
  const before = deps.getState().activePendingCreationId
  let done = false
  let settleTimer: unknown = null
  const finish = (): void => {
    if (done) {
      return
    }
    done = true
    unsubscribe()
    deps.clearTimer(maxTimer)
    if (settleTimer !== null) {
      deps.clearTimer(settleTimer)
    }
    deps.closePage()
  }
  const createTookOver = (state: HandoffState): boolean =>
    state.activePendingCreationId !== null && state.activePendingCreationId !== before
  const check = (state: HandoffState): void => {
    if (createTookOver(state)) {
      finish()
      return
    }
    // Closed with no create yet: the submit may publish its pending entry in the same tick.
    if (state.activeModal !== COMPOSER_MODAL && settleTimer === null) {
      settleTimer = deps.setTimer(finish, 0)
    }
  }
  const unsubscribe = deps.subscribe(check)
  const maxTimer = deps.setTimer(finish, SETUP_HANDOFF_MAX_MS)
  return () => {
    if (!done) {
      done = true
      unsubscribe()
      deps.clearTimer(maxTimer)
      if (settleTimer !== null) {
        deps.clearTimer(settleTimer)
      }
    }
  }
}
