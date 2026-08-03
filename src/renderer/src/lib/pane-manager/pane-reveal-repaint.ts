import type { ManagedPaneInternal } from './pane-manager-types'
import { reattachWebglIfNeeded } from './pane-webgl-reattach'
import { resetWebglTextureAtlas } from './pane-webgl-renderer'

function scheduleSettledFrame(callback: () => void): void {
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.setTimeout(callback, 0)
    return
  }
  // Why: the first frame after a reveal can still be laying out the tab
  // overlay; the WebGL renderer silently drops redraw requests until the pane
  // is attached and measured, so repaint on the frame after layout settles.
  globalThis.requestAnimationFrame(() => {
    globalThis.requestAnimationFrame(callback)
  })
}

function forEachPaneOnSettledFrame(
  getPanes: () => Iterable<ManagedPaneInternal>,
  visit: (pane: ManagedPaneInternal) => void
): void {
  scheduleSettledFrame(() => {
    for (const pane of getPanes()) {
      try {
        visit(pane)
      } catch {
        /* ignore — one pane's failure must not block repaint of the rest */
      }
    }
  })
}

/**
 * Repaints a revealed tab's panes from their xterm buffers.
 *
 * Why: while a pane is hidden, parsed output can update the WebGL renderer's
 * per-cell model without ever presenting a frame. At reveal the model diff
 * reports those cells unchanged, so plain refreshes skip them and the canvas
 * keeps compositing pre-hide pixels until a selection or resize rebuilds the
 * model. Clearing the model per pane — after (re)attach, once layout has
 * settled — forces a full rebuild from the buffer without any PTY resize.
 */
export function schedulePaneRevealRepaint(getPanes: () => Iterable<ManagedPaneInternal>): void {
  forEachPaneOnSettledFrame(getPanes, (pane) => {
    reattachWebglIfNeeded(pane)
    resetWebglTextureAtlas(pane)
  })
}

/**
 * Presents already-visible panes without clearing the shared glyph atlas.
 *
 * Why: a plain window refocus never hid its panes, so their WebGL model is
 * already current — a `refresh` re-presents the live buffer (covering a
 * compositor that dropped frames while occluded). Using the atlas-clearing
 * reveal repaint here would wipe the atlas shared by every same-config pane and
 * re-arm the mid-stream page-merge garble race (xterm.js issue 4480); this path
 * must stay texture-atlas-preserving.
 */
export function schedulePaneRevealPresent(getPanes: () => Iterable<ManagedPaneInternal>): void {
  forEachPaneOnSettledFrame(getPanes, (pane) => {
    reattachWebglIfNeeded(pane)
    if (pane.terminal.rows > 0) {
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
  })
}
