/**
 * Forces a full synchronous repaint through xterm's RenderService even when its
 * IntersectionObserver still reports the screen element as not intersecting.
 *
 * Why: on tab/worktree reveal the pane is DOM-visible but xterm's own
 * observer callback can lag a frame (worse under load), leaving
 * `RenderService._isPaused === true`. While paused, `refreshRows` early-returns
 * and only latches `_needsFullRefresh`, so the reveal-repaint's
 * `terminal.refresh()` is swallowed — the freshly-cleared render model never
 * repaints and the canvas keeps compositing stale rows (classic "bottom rows
 * missing until you drag-select" symptom). We can't wait for the observer, so
 * we clear the latch and drive one synchronous full render ourselves; the
 * observer reasserts authority naturally on its next callback.
 *
 * All access is behind typeof guards: an xterm upgrade that renames these
 * internals degrades to a no-op (callers keep their existing refresh path), it
 * never throws into a render frame.
 */

type MaybePausableRenderService = {
  _isPaused?: boolean
  _needsFullRefresh?: boolean
  refreshRows?: (start: number, end: number, sync?: boolean) => void
}

type PausableRenderService = MaybePausableRenderService & {
  refreshRows: (start: number, end: number, sync?: boolean) => void
}

type TerminalWithRenderService = {
  rows?: number
  _core?: {
    _renderService?: MaybePausableRenderService
  }
}

function getRenderService(terminal: unknown): PausableRenderService | null {
  const service = (terminal as TerminalWithRenderService | null)?._core?._renderService
  return service && typeof service.refreshRows === 'function'
    ? (service as PausableRenderService)
    : null
}

/**
 * If xterm's renderer is paused (observer hasn't caught up to the reveal),
 * clear the pause latch and force a synchronous full-viewport repaint.
 * Returns true when it drove the render, false when it left the terminal
 * untouched (not paused, or internals unavailable) so the caller can fall back
 * to its normal `terminal.refresh()`.
 */
export function forceRepaintThroughRenderPause(terminal: unknown): boolean {
  const service = getRenderService(terminal)
  if (!service || service._isPaused !== true) {
    return false
  }

  const rows = (terminal as TerminalWithRenderService).rows
  if (typeof rows !== 'number' || rows < 1) {
    return false
  }

  // Why: leave the latch as if the pending full refresh was serviced — we are
  // about to service it — so the observer's next callback doesn't queue a
  // redundant second full repaint.
  service._isPaused = false
  service._needsFullRefresh = false
  try {
    service.refreshRows(0, rows - 1, true)
    return true
  } catch {
    return false
  }
}
