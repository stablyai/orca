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

function hasPaneFitPixelBox(pane: ManagedPane): boolean {
  const measure = pane.container?.getBoundingClientRect
  if (typeof measure !== 'function') {
    return true
  }
  const rect = measure.call(pane.container)
  return rect.width >= MIN_PANE_FIT_WIDTH_PX && rect.height >= MIN_PANE_FIT_HEIGHT_PX
}

export function canMeasurePaneForFit(pane: ManagedPane): boolean {
  if (!hasPaneFitPixelBox(pane)) {
    return false
  }
  const dims = getProposedPaneDimensions(pane)
  if (!dims) {
    return false
  }
  // Worktree switches can briefly expose near-zero overlays; fitting would pin the PTY near two columns.
  return dims.cols >= MIN_PANE_FIT_COLS && dims.rows >= MIN_PANE_FIT_ROWS
}

// Gate metrics by pixels only: the 50px divider minimum can stay below the grid-fit floor forever, stranding font updates. Near-zero hidden/transient boxes still defer; the grid floor applies to fitting.
export function canApplyPaneMetricOptions(pane: ManagedPane): boolean {
  return !isManagedPaneDisplayNone(pane) && hasPaneFitPixelBox(pane)
}

// Check pending state before forcing layout; reveals without deferred metrics need no DOM reads.
export function flushDeferredPaneMetricOptionsIfMeasurable(pane: ManagedPane): boolean {
  if (!hasDeferredPaneMetricOptions(pane) || !canApplyPaneMetricOptions(pane)) {
    return false
  }
  return flushDeferredPaneMetricOptions(pane)
}
