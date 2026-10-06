import type { ManagedPaneInternal } from './pane-manager-types'
import { reattachWebglIfNeeded } from './pane-webgl-reattach'
import { presentPaneViewportPreservingSynchronizedOutput } from './pane-webgl-renderer'
import { resetAndRefreshAllTerminalWebglAtlases } from './pane-manager-registry'

type PaneGetter = () => Iterable<ManagedPaneInternal>
type PaneRevealOwner = { isVisibleForAtlasRecovery(): boolean }

const revealPaneGetters = new WeakMap<PaneRevealOwner, PaneGetter>()

const pendingRevealRepaints = new Set<PaneGetter>()
let revealRepaintScheduled = false

function resolvePaneGetter(
  ownerOrGetter: PaneRevealOwner | PaneGetter,
  panes?: ReadonlyMap<number, ManagedPaneInternal>
): PaneGetter {
  if (typeof ownerOrGetter === 'function') {
    return ownerOrGetter
  }
  const cached = revealPaneGetters.get(ownerOrGetter)
  if (cached) {
    return cached
  }
  if (!panes) {
    throw new Error('A reveal owner requires its pane map')
  }
  // Hidden-window frames can outlive a destroyed manager's mount context.
  const ownerRef = new WeakRef(ownerOrGetter)
  const panesRef = new WeakRef(panes)
  const getPanes: PaneGetter = () => {
    const owner = ownerRef.deref()
    return owner?.isVisibleForAtlasRecovery() ? (panesRef.deref()?.values() ?? []) : []
  }
  revealPaneGetters.set(ownerOrGetter, getPanes)
  return getPanes
}

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

function flushPaneRevealRepaints(): void {
  revealRepaintScheduled = false
  const paneGetters = Array.from(pendingRevealRepaints)
  pendingRevealRepaints.clear()
  const livePanes = new Set<ManagedPaneInternal>()

  for (const getPanes of paneGetters) {
    try {
      for (const pane of getPanes()) {
        livePanes.add(pane)
      }
    } catch {
      /* ignore — a manager may be destroyed while its repaint is pending */
    }
  }

  for (const pane of livePanes) {
    try {
      reattachWebglIfNeeded(pane)
    } catch {
      /* ignore — one pane's teardown must not block global recovery */
    }
  }
  if (livePanes.size > 0) {
    resetAndRefreshAllTerminalWebglAtlases('settled-reveal')
  }
}

/**
 * Repaints a revealed tab's panes from their xterm buffers.
 *
 * Why: while a pane is hidden, parsed output can update the WebGL renderer's
 * per-cell model without ever presenting a frame. At reveal the model diff
 * reports those cells unchanged, so plain refreshes skip them and the canvas
 * keeps compositing pre-hide pixels until a selection or resize rebuilds the
 * model. Once layout settles, reattach every revealed renderer before one
 * registry-wide atlas reset so no delayed pane-local clear can invalidate a
 * sibling terminal's rebuilt model.
 */
export function schedulePaneRevealRepaint(getPanes: PaneGetter): void
export function schedulePaneRevealRepaint(
  owner: PaneRevealOwner,
  panes: ReadonlyMap<number, ManagedPaneInternal>
): void
export function schedulePaneRevealRepaint(
  ownerOrGetter: PaneRevealOwner | PaneGetter,
  panes?: ReadonlyMap<number, ManagedPaneInternal>
): void {
  pendingRevealRepaints.add(resolvePaneGetter(ownerOrGetter, panes))
  if (revealRepaintScheduled) {
    return
  }
  revealRepaintScheduled = true
  scheduleSettledFrame(flushPaneRevealRepaints)
}

/** Presents panes without clearing the shared glyph atlas or bypassing DEC 2026. */
export function schedulePaneRevealPresent(getPanes: PaneGetter): void
export function schedulePaneRevealPresent(
  owner: PaneRevealOwner,
  panes: ReadonlyMap<number, ManagedPaneInternal>
): void
export function schedulePaneRevealPresent(
  ownerOrGetter: PaneRevealOwner | PaneGetter,
  panes?: ReadonlyMap<number, ManagedPaneInternal>
): void {
  forEachPaneOnSettledFrame(resolvePaneGetter(ownerOrGetter, panes), (pane) => {
    reattachWebglIfNeeded(pane)
    presentPaneViewportPreservingSynchronizedOutput(pane)
  })
}
