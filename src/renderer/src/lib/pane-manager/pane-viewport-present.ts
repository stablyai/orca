import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'
import { isManagedPaneDisplayNone } from './pane-display-visibility'
import { requestFullViewportPresent } from './terminal-render-pause-release'

// Presenting a pane's viewport is a distinct concern from owning the WebGL
// addon's lifecycle: it runs for DOM-rendered panes too, and its retry loop is
// about DOM visibility, not about the renderer.

const DISPLAYED_PRESENT_RETRY_FRAMES = 16
type DisplayedPresentRetry = { frames: number }
const pendingDisplayedPresentRetries = new WeakMap<ManagedPaneInternal, DisplayedPresentRetry>()
// Public pane views are recreated; terminal teardown must cancel every view's retry.
const presentRetryCancellations = new WeakMap<ManagedPane['terminal'], Set<() => void>>()

export function cancelPendingTerminalViewportPresents(terminal: ManagedPane['terminal']): void {
  for (const cancel of presentRetryCancellations.get(terminal) ?? []) {
    cancel()
  }
}

function schedulePresentWhenDisplayed(pane: ManagedPaneInternal): void {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    return
  }
  if (pendingDisplayedPresentRetries.has(pane)) {
    return
  }
  pendingDisplayedPresentRetries.set(pane, { frames: DISPLAYED_PRESENT_RETRY_FRAMES })
  const terminal = pane.terminal
  const cancellations = presentRetryCancellations.get(terminal) ?? new Set<() => void>()
  presentRetryCancellations.set(terminal, cancellations)
  let frameId: number | null = null
  let cancelled = false
  const finish = (): void => {
    pendingDisplayedPresentRetries.delete(pane)
    cancellations.delete(cancel)
    if (cancellations.size === 0) {
      presentRetryCancellations.delete(terminal)
    }
  }
  const cancel = (): void => {
    cancelled = true
    if (frameId !== null) {
      globalThis.cancelAnimationFrame(frameId)
      frameId = null
    }
    finish()
  }
  cancellations.add(cancel)
  const tick = (): void => {
    frameId = null
    if (cancelled) {
      return
    }
    const retry = pendingDisplayedPresentRetries.get(pane)
    if (!retry || retry.frames <= 0 || !pane.terminal) {
      finish()
      return
    }
    if (isManagedPaneDisplayNone(pane)) {
      if (retry.frames === 1) {
        finish()
        return
      }
      retry.frames -= 1
      frameId = globalThis.requestAnimationFrame(tick)
      return
    }
    finish()
    presentPaneViewport(pane)
  }
  frameId = globalThis.requestAnimationFrame(tick)
}

/**
 * Presents the full viewport, keeping the last coherent canvas while a TUI holds
 * DEC 2026 synchronized output.
 *
 * Why one mode: a forced paint mid-frame publishes the TUI's erase-then-repaint
 * half frame (a blank flash; #32198). Every reveal and atlas recovery waits for
 * the frame instead, bounded by xterm's synchronized-output safety timeout.
 */
export function presentPaneViewport(pane: ManagedPane): void {
  const internal = pane as ManagedPaneInternal
  if (internal.webglDisabledAfterContextLoss) {
    return
  }
  try {
    // Why: on reveal xterm's IntersectionObserver can still report the pane as
    // not intersecting, so a plain refresh() is swallowed by RenderService's
    // paused-render gate and the pending model never repaints (stale bottom rows
    // until a drag-select forces a redraw). Request one synchronous full present
    // even if the observer already unpaused; only fall back to refresh() when
    // internals are unavailable.
    //
    // Why the display check: that release is only right for a pane that is
    // DOM-visible. A pane with no box at all (collapsed sibling of an expanded
    // pane, a restore that stays display:none for its whole reattach) is
    // legitimately paused, and releasing it paints into nothing and then leaves
    // the service unpaused for good — the observer only
    // fires on a change, so it never re-pauses. Clearing _needsFullRefresh with
    // it also drops the full repaint the observer owes the pane on reveal, and
    // the deferred _pausedResizeTask that flushes alongside it. Latching is what
    // xterm's own gate does, and the reveal repaints from the latch.
    if (isManagedPaneDisplayNone(pane)) {
      pane.terminal.refresh(0, pane.terminal.rows - 1)
      // Why: light tab reveal runs while the overlay is still display:none
      // (field trace: paused=true needFull=true at click). A plain refresh only
      // latches _needsFullRefresh; if IntersectionObserver never fires, the
      // canvas keeps pre-hide pixels until a user resize. Retry once the box
      // exists so the full present actually runs.
      schedulePresentWhenDisplayed(internal)
      return
    }
    if (!requestFullViewportPresent(pane.terminal)) {
      // Why: refresh even without a WebGL addon so recovery never silently
      // no-ops — a DOM-rendered pane can hold stale pixels after reveal too.
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
  } catch {
    /* ignore — pane may have been disposed in the meantime */
  }
}
