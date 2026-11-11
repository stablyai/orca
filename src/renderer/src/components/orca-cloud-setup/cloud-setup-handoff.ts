// The setup page hands the screen to the start screen. It used to close first and then let the
// hidden composer auto-start, so for a few frames the workspace underneath (a terminal) showed
// before "Starting your cloud workspace" did (Neil, build ff845fe). Now the page stays up until the
// create's start screen has actually painted, or the composer goes away without a create.

type HandoffState = { activePendingCreationId: string | null; activeModal: string }

export type HandoffDeps<Timer> = {
  getState: () => HandoffState
  subscribe: (listener: (state: HandoffState) => void) => () => void
  /** True once the start screen is in the DOM (its lazy chunk may land a few frames later). */
  startScreenShown: () => boolean
  closePage: () => void
  setTimer: (callback: () => void, ms: number) => Timer
  clearTimer: (handle: Timer) => void
}

/** The hidden composer reveals itself after 8 s; past that the dialog sits over the page anyway. */
export const SETUP_HANDOFF_MAX_MS = 10_000
/** How long to wait for the start screen to paint once its create is active. */
export const SETUP_HANDOFF_PAINT_MAX_MS = 2_000
const PAINT_POLL_MS = 16
const COMPOSER_MODAL = 'new-workspace-composer'

/** Call right after opening the auto-starting composer. Returns a cancel. */
export function closeSetupPageWhenCreateTakesOver<Timer>(deps: HandoffDeps<Timer>): () => void {
  const before = deps.getState().activePendingCreationId
  let done = false
  const timers = new Set<Timer>()
  const later = (callback: () => void, ms: number): void => {
    const handle = deps.setTimer(() => {
      timers.delete(handle)
      callback()
    }, ms)
    timers.add(handle)
  }
  const stop = (): void => {
    done = true
    unsubscribe()
    for (const handle of timers) {
      deps.clearTimer(handle)
    }
    timers.clear()
  }
  const finish = (): void => {
    if (!done) {
      stop()
      deps.closePage()
    }
  }
  let waitingForPaint = false
  // The create is active: keep covering until its start screen is on screen (or give up).
  const awaitPaint = (): void => {
    if (waitingForPaint) {
      return
    }
    waitingForPaint = true
    const startedAt = Date.now()
    const poll = (): void => {
      if (deps.startScreenShown() || Date.now() - startedAt >= SETUP_HANDOFF_PAINT_MAX_MS) {
        finish()
        return
      }
      later(poll, PAINT_POLL_MS)
    }
    poll()
  }
  let closeGraceArmed = false
  const check = (state: HandoffState): void => {
    if (done) {
      return
    }
    if (state.activePendingCreationId !== null && state.activePendingCreationId !== before) {
      awaitPaint()
      return
    }
    // Closed with no create yet: the submit may publish its pending entry in the same tick.
    if (state.activeModal !== COMPOSER_MODAL && !closeGraceArmed && !waitingForPaint) {
      closeGraceArmed = true
      later(() => {
        if (!waitingForPaint) {
          finish()
        }
      }, 0)
    }
  }
  const unsubscribe = deps.subscribe(check)
  later(finish, SETUP_HANDOFF_MAX_MS)
  return () => {
    if (!done) {
      stop()
    }
  }
}
