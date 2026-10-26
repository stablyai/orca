import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'
import { isManagedPaneDisplayNone } from './pane-display-visibility'
import { requestFullViewportPresent } from './terminal-render-pause-release'

/** Viewport presentation also serves DOM panes; keep visibility retries separate from WebGL lifecycle. */

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

/** Retain the coherent canvas during DEC 2026: mid-frame forced painting exposes erase/repaint flashes (#32198). Reveal/atlas recovery waits, bounded by xterm’s synchronized-output safety timeout. */
export function presentPaneViewport(pane: ManagedPane): void {
  const internal = pane as ManagedPaneInternal
  if (internal.webglDisabledAfterContextLoss) {
    return
  }
  try {
    // Visible reveal can beat IntersectionObserver unpause; force a full present (refresh fallback if internals are absent). No-box panes must remain paused with full-refresh/resize latches intact: the observer may never re-pause, and clearing them loses reveal’s owed repaint.
    if (isManagedPaneDisplayNone(pane)) {
      pane.terminal.refresh(0, pane.terminal.rows - 1)
      // Reveal can run before the overlay has a box; retry when measurable or missed IntersectionObserver events leave stale pixels until resize.
      schedulePresentWhenDisplayed(internal)
      return
    }
    if (!requestFullViewportPresent(pane.terminal)) {
      // DOM panes can retain stale pixels too; refresh without requiring WebGL.
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
  } catch {
    /* ignore — pane may have been disposed in the meantime */
  }
}
