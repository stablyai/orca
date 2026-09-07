import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'
import { isManagedPaneDisplayNone } from './pane-display-visibility'
import {
  forceFullViewportPresent,
  requestFullViewportPresent
} from './terminal-render-pause-release'

// Presenting a pane's viewport is a distinct concern from owning the WebGL
// addon's lifecycle: it runs for DOM-rendered panes too, and its retry loop is
// about DOM visibility, not about the renderer.

const DISPLAYED_PRESENT_RETRY_FRAMES = 16
type ViewportPresentMode = 'preserve-synchronized-output' | 'force-current-buffer'
type DisplayedPresentRetry = { frames: number; mode: ViewportPresentMode }
const pendingDisplayedPresentRetries = new WeakMap<ManagedPaneInternal, DisplayedPresentRetry>()

function schedulePresentWhenDisplayed(pane: ManagedPaneInternal, mode: ViewportPresentMode): void {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    return
  }
  const pending = pendingDisplayedPresentRetries.get(pane)
  if (pending) {
    if (mode === 'force-current-buffer') {
      pending.mode = mode
    }
    return
  }
  pendingDisplayedPresentRetries.set(pane, {
    frames: DISPLAYED_PRESENT_RETRY_FRAMES,
    mode
  })
  const tick = (): void => {
    const retry = pendingDisplayedPresentRetries.get(pane)
    if (!retry || retry.frames <= 0 || !pane.terminal) {
      pendingDisplayedPresentRetries.delete(pane)
      return
    }
    if (isManagedPaneDisplayNone(pane)) {
      if (retry.frames === 1) {
        pendingDisplayedPresentRetries.delete(pane)
        return
      }
      retry.frames -= 1
      globalThis.requestAnimationFrame(tick)
      return
    }
    pendingDisplayedPresentRetries.delete(pane)
    presentPaneViewportWithMode(pane, retry.mode)
  }
  globalThis.requestAnimationFrame(tick)
}

function presentPaneViewportWithMode(pane: ManagedPane, mode: ViewportPresentMode): void {
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
      schedulePresentWhenDisplayed(internal, mode)
      return
    }
    const presented =
      mode === 'force-current-buffer'
        ? forceFullViewportPresent(pane.terminal)
        : requestFullViewportPresent(pane.terminal)
    if (!presented) {
      // Why: refresh even without a WebGL addon so recovery never silently
      // no-ops — a DOM-rendered pane can hold stale pixels after reveal too.
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
  } catch {
    /* ignore — pane may have been disposed in the meantime */
  }
}

export function presentPaneViewport(pane: ManagedPane): void {
  presentPaneViewportWithMode(pane, 'force-current-buffer')
}

export function presentPaneViewportPreservingSynchronizedOutput(pane: ManagedPane): void {
  presentPaneViewportWithMode(pane, 'preserve-synchronized-output')
}
