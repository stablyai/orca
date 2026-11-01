// Correct late startup layout changes across frames, bypassing visibility until live onResize is authoritative and stable; verify applied PTY size before handoff when supported.

export type PtySizeReconcileDimensions = { cols: number; rows: number }

export type PtySizeReconcileOptions = {
  /** Dimensions the PTY was spawned at — the size it currently believes it is. */
  spawnCols: number
  spawnRows: number
  /** True while this reconcile still owns a live PTY (not disposed / not rebound). */
  isAlive: () => boolean
  /** True while the PTY is legitimately parked at non-pane dims (mobile driving); such frames are skipped but still count toward the hard cap. */
  isParked: () => boolean
  /** Visible onResize can own future corrections; require stable authoritative frames before handing off. */
  isAuthoritative: () => boolean
  /** Fit the pane and return its measured grid, or null when not yet measurable. */
  measure: () => PtySizeReconcileDimensions | null
  /** Forward the settled size to the PTY (authoritative — bypasses visibility). */
  resize: (cols: number, rows: number) => void
  /** Optional applied-size verification before handoff; null means unsupported and permits handoff. */
  getAppliedSize?: () => Promise<PtySizeReconcileDimensions | null>
  /** Schedule the next frame; mirrors requestAnimationFrame's id contract. */
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
}

export type PtySizeReconcileHandle = { cancel: () => void }

// Count stable frames only under authority; cap all frames to terminate hidden/oscillating layouts.
const POST_SPAWN_RECONCILE_SETTLE_FRAMES = 8
const POST_SPAWN_RECONCILE_MAX_FRAMES = 180

// Fallback grid when a visible pane never measures and the PTY is stuck at 0×0 (blank/white pane); 80×24 is the terminal default.
const POST_SPAWN_RECONCILE_FALLBACK_COLS = 80
const POST_SPAWN_RECONCILE_FALLBACK_ROWS = 24

export function reconcilePtySizeAcrossFrames(
  options: PtySizeReconcileOptions
): PtySizeReconcileHandle {
  let frame = 0
  // Hidden stability cannot hand off because no live resize path owns correction yet.
  let authoritativeStableFrames = 0
  let lastSentCols = options.spawnCols
  let lastSentRows = options.spawnRows
  let pendingFrame: number | null = null
  let cancelled = false
  // Allow one applied-size read in flight before handoff.
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
          options.resize(measured.cols, measured.rows)
          lastSentCols = measured.cols
          lastSentRows = measured.rows
          authoritativeStableFrames = 0
          appliedVerified = options.getAppliedSize === undefined
        } else if (options.isAuthoritative()) {
          authoritativeStableFrames += 1
        }
      }
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
          // Recheck mobile ownership after async readback; the request-time check cannot fence later takeover.
          if (options.isParked()) {
            return
          }
          if (applied && (applied.cols !== lastSentCols || applied.rows !== lastSentRows)) {
            options.resize(lastSentCols, lastSentRows)
            authoritativeStableFrames = 0
          } else {
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
    // At the hard cap, visible never-measurable zero-sized PTYs need a safe default to avoid blank panes.
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
