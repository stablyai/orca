/**
 * Detects pointer events Chromium leaks out of a `<webview>` guest, and repairs the hover state they
 * corrupt.
 *
 * Why: releasing the mouse inside a browser/mobile pane delivers the embedder a `pointerup` whose
 * `screenX/screenY` are correct but whose `clientX/clientY` are the *guest's* viewport coordinates,
 * untranslated. Blink hit-tests that point in the host document — one webview origin up and to the left
 * of the real cursor, so usually the sidebar — which both fires phantom hover affordances and parks
 * `:hover` on a row the pointer never visited.
 *
 * The tell is exact rather than heuristic: for a genuine host event `screen - client` equals the window's
 * content origin, while a leaked one is off by the webview's origin. The origin is learned from the
 * events Chromium never leaks (press and move) so this keeps working across window moves, platform frame
 * differences, and display scale changes.
 */
const ORIGIN_TOLERANCE_PX = 1

type PointerSample = { clientX: number; clientY: number; screenX: number; screenY: number }

// Why scalars, not an object: calibration runs on every host pointermove, so the common path must not
// allocate. It is also the reason each branch below re-reads the two deltas instead of boxing them.
let calibrated = false
let originX = 0
let originY = 0
let hasPending = false
let pendingX = 0
let pendingY = 0
let installed = false

function near(a: number, b: number): boolean {
  const delta = a - b
  return delta <= ORIGIN_TOLERANCE_PX && delta >= -ORIGIN_TOLERANCE_PX
}

/**
 * Feed an event Chromium delivers with embedder coordinates. `pointerdown` is authoritative (a press
 * inside a guest produces no host press at all); a `pointermove` only re-calibrates after two agreeing
 * samples, so one anomalous event cannot move the reference.
 */
export function calibrateHostPointerOrigin(
  event: PointerSample,
  { authoritative }: { authoritative: boolean }
): void {
  const x = event.screenX - event.clientX
  const y = event.screenY - event.clientY
  if (calibrated && near(x, originX) && near(y, originY)) {
    hasPending = false
    return
  }
  if (authoritative || !calibrated) {
    calibrated = true
    originX = x
    originY = y
    hasPending = false
    return
  }
  if (hasPending && near(x, pendingX) && near(y, pendingY)) {
    originX = x
    originY = y
    hasPending = false
    return
  }
  hasPending = true
  pendingX = x
  pendingY = y
}

/** True when the event's client coordinates belong to a `<webview>` guest rather than this document. */
export function isLeakedGuestPointerEvent(event: PointerSample): boolean {
  if (!calibrated) {
    // Why: fail open — before calibration, treating events as leaked would break all hover.
    return false
  }
  return (
    !near(event.screenX - event.clientX, originX) || !near(event.screenY - event.clientY, originY)
  )
}

/**
 * True when `event` is real hover intent: coordinates that belong to this document, with no button held.
 * The held-button clause matches `focus-follows-mouse`, where a press means a selection or drag.
 */
export function isGenuineHostPointerEnter(event: PointerSample & { buttons: number }): boolean {
  return event.buttons === 0 && !isLeakedGuestPointerEvent(event)
}

/**
 * Watch for leaks and ask the main process to drop the window's hover state when one lands. Renderers
 * cannot clear it themselves: `pointer-events: none` leaves the stale `:hover` applied and untrusted
 * events never move Blink's hover target.
 */
export function installWebviewPointerLeakCorrection(): () => void {
  if (installed) {
    return () => {}
  }
  installed = true
  const onAuthoritative = (event: PointerEvent): void => {
    calibrateHostPointerOrigin(event, { authoritative: true })
  }
  const onMotion = (event: PointerEvent): void => {
    calibrateHostPointerOrigin(event, { authoritative: false })
  }
  const onLeakCandidate = (event: PointerEvent): void => {
    if (!isLeakedGuestPointerEvent(event)) {
      return
    }
    // Why: with nothing hovered there is nothing to repair, which also keeps repeated leaks from
    // re-invoking the main process on every mouse release.
    if (document.querySelectorAll(':hover').length === 0) {
      return
    }
    void window.api.ui.clearStaleHoverState().catch(() => {
      // Why: hover repair is cosmetic — a closed window or missing host must not surface an error.
    })
  }
  const listeners: [string, (event: PointerEvent) => void][] = [
    ['pointerdown', onAuthoritative],
    ['pointermove', onMotion],
    ['pointerup', onLeakCandidate],
    ['pointerover', onLeakCandidate]
  ]
  for (const [type, listener] of listeners) {
    window.addEventListener(type, listener as EventListener, { capture: true, passive: true })
  }
  return () => {
    for (const [type, listener] of listeners) {
      window.removeEventListener(type, listener as EventListener, { capture: true })
    }
    installed = false
  }
}

/** Test seam: forget calibration between cases. */
export function resetHostPointerOriginForTests(): void {
  calibrated = false
  hasPending = false
  installed = false
}
