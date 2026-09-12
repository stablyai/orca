// Why: the deferred-rAF fit can spawn the PTY at a stale (wide) width when the pane's layout hasn't settled by the first
// frame (e.g. a tab mounting with a split already present) and the corrective xterm onResize is dropped during the hidden
// mount window (visibility gate not yet authoritative), so TUIs render garbled until a manual resize. This post-spawn
// reconcile bridges that gap: it polls across frames, forwarding xterm's measured grid (authoritative, bypasses the gate)
// until the pane is authoritative and stable, then hands off to the live onResize path. It tracks what it last SENT, not
// what the PTY applied; the visibility-resume re-assert in pty-connection.ts is the backstop that heals drift on hide/show.

export type PtySizeReconcileDimensions = { cols: number; rows: number }

export type PtySizeReconcileOptions = {
  /** Dimensions the PTY was spawned at — the size it currently believes it is. */
  spawnCols: number
  spawnRows: number
  /** True while this reconcile still owns a live PTY (not disposed / not rebound). */
  isAlive: () => boolean
  /** True while the PTY is legitimately parked at non-pane dims (mobile driving); such frames are skipped but still count toward the hard cap. */
  isParked: () => boolean
  /** True once the live onResize path will forward future PTY resizes itself (pane visible); the reconcile only needs to run while this is false. */
  isAuthoritative: () => boolean
  /** Fit the pane and return its measured grid, or null when not yet measurable. */
  measure: () => PtySizeReconcileDimensions | null
  /** Forward the settled size to the PTY (authoritative — bypasses visibility). */
  resize: (cols: number, rows: number) => void
  /** Read the size the PTY has ACTUALLY applied (vs what the loop last sent). Optional; remote resize() is fire-and-forget, so the loop verifies once before handoff. Null = can't confirm (treated as synced enough to hand off). */
  getAppliedSize?: () => Promise<PtySizeReconcileDimensions | null>
  /** Schedule the next frame; mirrors requestAnimationFrame's id contract. */
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
}

export type PtySizeReconcileHandle = { cancel: () => void }

// Hand off once the grid holds steady for SETTLE_FRAMES observed *while authoritative* — hidden frames don't count, since the reconcile is the sole corrector then.
// MAX_FRAMES (~3s at 60fps) guarantees termination for a pane that never becomes authoritative or never stabilizes.
const POST_SPAWN_RECONCILE_SETTLE_FRAMES = 8
const POST_SPAWN_RECONCILE_MAX_FRAMES = 180

// Fallback grid when a visible pane never measures and the PTY is stuck at 0×0 (blank/white pane); 80×24 is the terminal default.
const POST_SPAWN_RECONCILE_FALLBACK_COLS = 80
const POST_SPAWN_RECONCILE_FALLBACK_ROWS = 24

export function reconcilePtySizeAcrossFrames(
  options: PtySizeReconcileOptions
): PtySizeReconcileHandle {
  let frame = 0
  // Consecutive unchanged frames seen *while authoritative*; hidden frames don't advance it, so we never hand off on an unconfirmed width.
  let authoritativeStableFrames = 0
  let lastSentCols = options.spawnCols
  let lastSentRows = options.spawnRows
  let pendingFrame: number | null = null
  let cancelled = false
  // One-shot applied-size verify before handoff: verifyInFlight guards the in-flight read; appliedVerified lets the loop stop.
  let verifyInFlight = false
  let appliedVerified = options.getAppliedSize === undefined

  const tick = (): void => {
    pendingFrame = null
    if (cancelled || !options.isAlive()) {
      return
    }
    frame += 1
    if (!options.isParked()) {
      const measured = options.measure()
      if (measured && measured.cols > 0 && measured.rows > 0) {
        if (measured.cols !== lastSentCols || measured.rows !== lastSentRows) {
          // Authoritative spawn-time correction: bypasses the visibility gate; a real change resets the stability window.
          options.resize(measured.cols, measured.rows)
          lastSentCols = measured.cols
          lastSentRows = measured.rows
          authoritativeStableFrames = 0
          appliedVerified = options.getAppliedSize === undefined
        } else if (options.isAuthoritative()) {
          // Only stability seen *under authority* counts toward handoff (steady-while-hidden isn't a safe stop).
          authoritativeStableFrames += 1
        }
      }
      // A null/zero measurement makes no stability progress: layout isn't ready.
    }
    const gridStable = authoritativeStableFrames >= POST_SPAWN_RECONCILE_SETTLE_FRAMES
    // Grid-stable proves what we SENT held, not what the PTY APPLIED (remote resize is fire-and-forget); verify once, skip parked.
    if (
      gridStable &&
      !appliedVerified &&
      !verifyInFlight &&
      !options.isParked() &&
      options.getAppliedSize
    ) {
      verifyInFlight = true
      void options
        .getAppliedSize()
        .then((applied) => {
          if (cancelled || !options.isAlive()) {
            return
          }
          // Re-check parked: a mobile client can take the PTY mid-read; the sync guard above only gated issuing the read, not this resolution.
          if (options.isParked()) {
            return
          }
          if (applied && (applied.cols !== lastSentCols || applied.rows !== lastSentRows)) {
            // The PTY never took our size — re-forward and keep the loop running.
            options.resize(lastSentCols, lastSentRows)
            authoritativeStableFrames = 0
          } else {
            // Applied matches, or cannot be confirmed (null) — safe to hand off.
            appliedVerified = true
          }
        })
        .catch(() => {
          // A failed read must not wedge the loop until MAX_FRAMES.
          appliedVerified = true
        })
        .finally(() => {
          verifyInFlight = false
        })
    }
    const settled = gridStable && appliedVerified
    if (!settled && frame < POST_SPAWN_RECONCILE_MAX_FRAMES) {
      pendingFrame = options.requestFrame(tick)
      return
    }
    // Last resort: a visible pane still pinned at 0×0 renders blank (split-right white-screen report); forward a safe default.
    if (
      !settled &&
      !options.isParked() &&
      options.isAuthoritative() &&
      lastSentCols <= 0 &&
      lastSentRows <= 0
    ) {
      options.resize(POST_SPAWN_RECONCILE_FALLBACK_COLS, POST_SPAWN_RECONCILE_FALLBACK_ROWS)
      lastSentCols = POST_SPAWN_RECONCILE_FALLBACK_COLS
      lastSentRows = POST_SPAWN_RECONCILE_FALLBACK_ROWS
    }
  }

  pendingFrame = options.requestFrame(tick)

  return {
    cancel: () => {
      cancelled = true
      if (pendingFrame !== null) {
        options.cancelFrame(pendingFrame)
        pendingFrame = null
      }
    }
  }
}
