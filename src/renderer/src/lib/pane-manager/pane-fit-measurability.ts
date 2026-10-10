import type { ManagedPane } from './pane-manager-types'
import { isManagedPaneDisplayNone } from './pane-display-visibility'
import {
  flushDeferredPaneMetricOptions,
  hasDeferredPaneMetricOptions
} from './pane-metric-options-deferral'

const MIN_PANE_FIT_WIDTH_PX = 48
const MIN_PANE_FIT_HEIGHT_PX = 24
const MIN_PANE_FIT_COLS = 8
const MIN_PANE_FIT_ROWS = 4

export function getProposedPaneDimensions(
  pane: ManagedPane
): { cols: number; rows: number } | null {
  try {
    return pane.fitAddon.proposeDimensions() ?? null
  } catch {
    return null
  }
}

/** The pixel floor: below it a box is a hidden pane or a transient near-zero overlay. */
export function isAbovePaneFitPixelFloor(width: number, height: number): boolean {
  return width >= MIN_PANE_FIT_WIDTH_PX && height >= MIN_PANE_FIT_HEIGHT_PX
}

/** The grid floor: a smaller grid was measured in a near-zero box and pins the PTY at ~2 cols. */
export function isAbovePaneFitGridFloor(cols: number, rows: number): boolean {
  return cols >= MIN_PANE_FIT_COLS && rows >= MIN_PANE_FIT_ROWS
}

function hasPaneFitPixelBox(pane: ManagedPane): boolean {
  const measure = pane.container?.getBoundingClientRect
  if (typeof measure !== 'function') {
    return true
  }
  const rect = measure.call(pane.container)
  return isAbovePaneFitPixelFloor(rect.width, rect.height)
}

export function canMeasurePaneForFit(pane: ManagedPane): boolean {
  if (!hasPaneFitPixelBox(pane)) {
    return false
  }
  const dims = getProposedPaneDimensions(pane)
  if (!dims) {
    return false
  }
  // Why: worktree switches can briefly measure a near-zero overlay before
  // fallback positioning lands. Fitting there pins the PTY at ~2 cols.
  return isAbovePaneFitGridFloor(dims.cols, dims.rows)
}

/** Why only the pixel box, not the fit floor: a pane held at the 50px divider
 *  clamp proposes ~5 cols, so the fit floor would reject it forever — it never
 *  hides and its box never changes, so nothing would flush and it would render
 *  a stale font until widened. A hidden pane or the transient worktree-switch
 *  overlay is near-zero, so the pixel floor still defers those. The cols/rows
 *  floor stays where it belongs: on the fit. */
export function canApplyPaneMetricOptions(pane: ManagedPane): boolean {
  return !isManagedPaneDisplayNone(pane) && hasPaneFitPixelBox(pane)
}

/** Why the pending check comes first: it is an O(1) WeakMap lookup, while the
 *  measurability probe forces style+layout. This runs per pane on every reveal,
 *  so the common no-deferral case must cost zero DOM reads. */
export function flushDeferredPaneMetricOptionsIfMeasurable(pane: ManagedPane): boolean {
  if (!hasDeferredPaneMetricOptions(pane) || !canApplyPaneMetricOptions(pane)) {
    return false
  }
  return flushDeferredPaneMetricOptions(pane)
}
