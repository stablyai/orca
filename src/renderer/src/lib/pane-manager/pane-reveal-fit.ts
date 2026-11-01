import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'
import {
  canMeasurePaneForFit,
  flushDeferredPaneMetricOptionsIfMeasurable,
  flushPendingSafeFitContinuations,
  readFitClientSize,
  safeFit
} from './pane-fit'
import { requestStablePaneFit } from './pane-fit-resize-observer'
import { clearPaneFitContinuationRetry } from './pane-fit-continuation-retry'
import { resumePendingFitScrollRestoreAfterFit } from './pane-scroll'

// Pixel changes indicate real resize; unknown/unmeasurable baselines still require a first fit.
export function paneFitClientSizeChanged(pane: ManagedPane): boolean {
  const last = (pane as ManagedPaneInternal).lastFitClientSize
  if (!last) {
    return true
  }
  const current = readFitClientSize(pane)
  if (!current || current.width <= 0 || current.height <= 0) {
    return true
  }
  return current.width !== last.width || current.height !== last.height
}

// Treat failed measurements as matching: safeFit would no-op, so reveal must not force reflow.
function proposedGridMatchesTerminal(pane: ManagedPane): boolean {
  try {
    const proposed = pane.fitAddon.proposeDimensions()
    if (!proposed) {
      return true
    }
    return proposed.cols === pane.terminal.cols && proposed.rows === pane.terminal.rows
  } catch {
    return true
  }
}

function releaseMeasurableFitContinuations(pane: ManagedPane): void {
  // Equal grids still release hidden replay/reattach continuations and parked scroll restore, as safeFit does.
  if (!canMeasurePaneForFit(pane)) {
    return
  }
  resumePendingFitScrollRestoreAfterFit(pane.terminal)
  flushPendingSafeFitContinuations(pane)
  clearPaneFitContinuationRetry(pane)
}

/** WebGL reattach can briefly change cell metrics; raw reflow is not perfectly reversible and corrupts diff-painted TUIs. Fit real pixel resizes immediately (before async PTY reassert); repair grid-only divergence after stabilization; leave matching grids alone. */
export function fitRevealedPane(pane: ManagedPane): void {
  // Flush parked metrics before early returns or unchanged pixels/grids could strand them forever.
  const flushed = flushDeferredPaneMetricOptionsIfMeasurable(pane)
  if (paneFitClientSizeChanged(pane)) {
    safeFit(pane)
    return
  }
  // Flushed metrics change grid without pixels; stabilize to avoid reflow on transient DOM/WebGL differences.
  if (flushed || !proposedGridMatchesTerminal(pane)) {
    requestStablePaneFit(pane)
    return
  }
  releaseMeasurableFitContinuations(pane)
}
