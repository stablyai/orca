/** Visible reveal can beat IntersectionObserver, leaving refresh swallowed behind pause/full-refresh latches and stale rows until selection. Release the pause and repaint; the next observer callback resumes authority. Guard private members so upgrades fall back to normal refresh without throwing. */

type MaybeWebglRenderer = {
  renderRows?: (start: number, end: number) => void
}

type MaybePausableRenderService = {
  _isPaused?: boolean
  _needsFullRefresh?: boolean
  _pausedResizeTask?: { flush?: () => void } | null
  refreshRows?: (start: number, end: number, sync?: boolean) => void
  _renderer?: { value?: MaybeWebglRenderer | null } | MaybeWebglRenderer | null
}

type PausableRenderService = MaybePausableRenderService & {
  refreshRows: (start: number, end: number, sync?: boolean) => void
}

type TerminalWithRenderService = {
  rows?: number
  _core?: {
    _renderService?: MaybePausableRenderService
    coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } }
    _coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } }
  }
}

/** Flush the renderer resize parked while paused before clearing full-refresh latches; only the observer normally flushes it, and presenting old canvas/model geometry produces fragments/bars until resize. */
function releaseRenderPause(service: PausableRenderService): void {
  // Clear the full-refresh latch as serviced to avoid a duplicate observer repaint.
  service._isPaused = false
  service._needsFullRefresh = false
  try {
    service._pausedResizeTask?.flush?.()
  } catch {
    // Why: a resize that throws mid-dispose must not block the present.
  }
}

function getRenderService(terminal: unknown): PausableRenderService | null {
  const service = (terminal as TerminalWithRenderService | null)?._core?._renderService
  return service && typeof service.refreshRows === 'function'
    ? (service as PausableRenderService)
    : null
}

/** If paused, release the latch and synchronously present the full viewport. False leaves normal refresh to callers when unpaused or internals are unavailable. */
export function forceRepaintThroughRenderPause(terminal: unknown): boolean {
  const service = getRenderService(terminal)
  if (!service || service._isPaused !== true) {
    return false
  }

  const rows = (terminal as TerminalWithRenderService).rows
  if (typeof rows !== 'number' || rows < 1) {
    return false
  }

  releaseRenderPause(service)
  try {
    service.refreshRows(0, rows - 1, true)
    return true
  } catch {
    return false
  }
}

/** Preserve the coherent canvas through DEC 2026; RenderService waits for frame close with xterm’s bounded safety timeout. */
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

  if (paused) {
    releaseRenderPause(service)
  }

  try {
    service.refreshRows(0, rows - 1, true)
    return true
  } catch {
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

export function isSynchronizedOutputHeld(terminal: unknown): boolean {
  const core = (terminal as TerminalWithRenderService)._core
  return (
    (core?.coreService?.decPrivateModes ?? core?._coreService?.decPrivateModes)
      ?.synchronizedOutput === true
  )
}

/** Force a full present through pause/DEC 2026 only for held keystroke echo or replay hold-cap expiry. Mid-frame painting exposes unfinished TUIs (#32198); reveal/recovery use requestFullViewportPresent. Normal unpaused paint falls back to refresh: direct first-splash renderRows precedes stable cell metrics and leaves a 1px gutter. */
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

  if (paused) {
    releaseRenderPause(service)
  }

  const renderer = getRenderer(service)
  try {
    // New tabs can still be observer-paused; use refreshRows for its dimension clamp to avoid a 1px gutter. Only DEC 2026 requires direct renderRows.
    if (syncHeld && typeof renderer?.renderRows === 'function') {
      renderer.renderRows(0, rows - 1)
      return true
    }
    service.refreshRows(0, rows - 1, true)
    return true
  } catch {
    // Keep pause cleared so the caller’s refresh fallback is not swallowed while waiting for IntersectionObserver.
    return false
  }
}
