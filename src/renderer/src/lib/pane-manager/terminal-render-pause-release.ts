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

type MaybeWebglRenderer = {
  renderRows?: (start: number, end: number) => void
  _isAttached?: boolean
}

type MaybePausableRenderService = {
  _isPaused?: boolean
  _needsFullRefresh?: boolean
  _pausedResizeTask?: { flush?: () => void } | null
  _charSizeService?: { width?: number; height?: number }
  refreshRows?: (start: number, end: number, sync?: boolean) => void
  _renderer?: { value?: MaybeWebglRenderer | null } | MaybeWebglRenderer | null
}

type PausableRenderService = MaybePausableRenderService & {
  refreshRows: (start: number, end: number, sync?: boolean) => void
}

type TerminalWithRenderService = {
  rows?: number
  _core?: {
    screenElement?: { isConnected?: boolean }
    _renderService?: MaybePausableRenderService
    coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } }
    _coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } }
  }
}

/**
 * Clears xterm's observer-pause latches and runs the renderer resize xterm parked
 * while paused.
 *
 * Why the flush: `RenderService.handleResize` under `_isPaused` only parks the
 * WebGL renderer's own resize on an idle task, and xterm flushes that task solely
 * from the observer callback gated on `_needsFullRefresh`. Clearing the latch
 * without flushing lets the present below paint the new grid through the old
 * canvas/model geometry (misplaced fragments, stray bars until a user resize).
 */
function releaseRenderPause(service: PausableRenderService, canPaint: boolean): void {
  service._isPaused = false
  // Why: the latch is xterm's own owed full repaint, and the observer only fires on
  // a change — so nothing re-owes it. Spending it is only right when the renderer we
  // are about to drive can actually paint; clearing it in front of a frame the
  // renderer drops leaves the canvas on pre-reveal pixels until a selection or
  // resize rebuilds the model. Otherwise we accept one redundant repaint instead.
  if (canPaint) {
    service._needsFullRefresh = false
  }
  try {
    service._pausedResizeTask?.flush?.()
  } catch {
    // Why: a resize that throws mid-dispose must not block the present.
  }
}

/**
 * Whether the renderer behind this service would paint a frame driven right now.
 *
 * The WebGL renderer returns from `renderRows` without drawing until it is attached,
 * and it only attaches once the screen element is connected and char metrics are
 * measured. The DOM renderer has no such gate — it rewrites rows from the buffer —
 * so an absent `_isAttached` means "paints".
 */
function canRendererPaintNow(terminal: unknown, service: PausableRenderService): boolean {
  const renderer = getRenderer(service)
  if (!renderer || typeof renderer._isAttached !== 'boolean') {
    return true
  }
  if (renderer._isAttached) {
    return true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same unknown-terminal narrowing getRenderService does; every field read below is optional and guarded.
  const core = (terminal as TerminalWithRenderService | null)?._core
  const charSize = service._charSizeService
  return (
    core?.screenElement?.isConnected === true &&
    typeof charSize?.width === 'number' &&
    charSize.width > 0 &&
    typeof charSize.height === 'number' &&
    charSize.height > 0
  )
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

  const canPaint = canRendererPaintNow(terminal, service)
  releaseRenderPause(service, canPaint)
  try {
    service.refreshRows(0, rows - 1, true)
    return canPaint
  } catch {
    // Why: no frame reached the canvas, so hand xterm's owed repaint back.
    service._needsFullRefresh = true
    return false
  }
}

/**
 * Requests a full viewport while preserving a TUI's synchronized-output frame.
 *
 * Why: ordinary reveal must not publish a half-built DEC 2026 frame. Routing
 * through RenderService keeps the previous canvas coherent and arms xterm's
 * bounded safety timeout if the TUI never closes the frame.
 */
export function requestFullViewportPresent(terminal: unknown): boolean {
  const service = getRenderService(terminal)
  if (!service) {
    return false
  }
  const rows = (terminal as TerminalWithRenderService).rows
  if (typeof rows !== 'number' || rows < 1) {
    return false
  }

  const paused = service._isPaused === true
  if (!paused && !isSynchronizedOutputHeld(terminal)) {
    return false
  }

  const canPaint = canRendererPaintNow(terminal, service)
  if (paused) {
    releaseRenderPause(service, canPaint)
  }

  try {
    service.refreshRows(0, rows - 1, true)
    // Why: an unattached renderer swallows that frame, so report "not presented"
    // and let the caller's refresh() fallback try again.
    return canPaint
  } catch {
    service._needsFullRefresh = true
    return false
  }
}

function getRenderer(service: MaybePausableRenderService): MaybeWebglRenderer | null {
  const holder = service._renderer
  if (!holder) {
    return null
  }
  if (typeof (holder as MaybeWebglRenderer).renderRows === 'function') {
    return holder as MaybeWebglRenderer
  }
  const wrapped = (holder as { value?: MaybeWebglRenderer | null }).value
  return wrapped ?? null
}

function isSynchronizedOutputHeld(terminal: unknown): boolean {
  const core = (terminal as TerminalWithRenderService)._core
  return (
    (core?.coreService?.decPrivateModes ?? core?._coreService?.decPrivateModes)
      ?.synchronizedOutput === true
  )
}

/**
 * One synchronous full-viewport present when xterm would otherwise swallow it:
 * IntersectionObserver pause, or DEC 2026 synchronized output.
 *
 * Why not on every paint: a forced renderer.renderRows on a fresh, unpaused
 * splash paints before cell metrics settle and leaves a 1px black gutter under
 * a TUI composer — production never does that. Callers fall back to
 * terminal.refresh() for the normal path.
 */
export function forceFullViewportPresent(terminal: unknown): boolean {
  const service = getRenderService(terminal)
  if (!service) {
    return false
  }
  const rows = (terminal as TerminalWithRenderService).rows
  if (typeof rows !== 'number' || rows < 1) {
    return false
  }

  const paused = service._isPaused === true
  const syncHeld = isSynchronizedOutputHeld(terminal)
  if (!paused && !syncHeld) {
    return false
  }

  const canPaint = canRendererPaintNow(terminal, service)
  if (paused) {
    releaseRenderPause(service, canPaint)
  }

  const renderer = getRenderer(service)
  try {
    // Why: a new TUI tab is often still paused (observer lag). Painting
    // via renderer.renderRows skips RenderService's dimension clamp and draws
    // 1px short of the composer box. Production uses refreshRows here.
    // renderer.renderRows is only for DEC 2026, which swallows refreshRows.
    if (syncHeld && typeof renderer?.renderRows === 'function') {
      renderer.renderRows(0, rows - 1)
      return canPaint
    }
    service.refreshRows(0, rows - 1, true)
    return canPaint
  } catch {
    // Why: leave _isPaused cleared so the caller's terminal.refresh() fallback can
    // still paint — restoring it would swallow that refresh until the observer
    // fires. The full-repaint latch is a different matter: nothing painted, so
    // xterm must keep owing it.
    service._needsFullRefresh = true
    return false
  }
}
