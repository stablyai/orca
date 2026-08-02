import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'
import {
  canMeasurePaneForFit,
  flushPendingSafeFitContinuations,
  readFitClientSize,
  safeFit
} from './pane-fit'
import { requestStablePaneFit } from './pane-fit-resize-observer'
import { clearPaneFitContinuationRetry } from './pane-fit-continuation-retry'
import { resumePendingFitScrollRestoreAfterFit } from './pane-scroll'

// Why: a real resize changes the element's pixels; a metric-only wobble does not.
// No baseline / unmeasurable counts as changed so a first reveal still fits.
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

// Why: missing/failed measurement counts as "matches" — safeFit would no-op
// there anyway, so reveal must not force a reflow.
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
  // Why: no reflow needed, but a pane that mounted hidden can have replay/reattach
  // continuations parked on a measurable fit — release them (and any parked scroll
  // restore, mirroring safeFit's equal-dims path) now it is visible.
  if (!canMeasurePaneForFit(pane)) {
    return
  }
  resumePendingFitScrollRestoreAfterFit(pane.terminal)
  flushPendingSafeFitContinuations(pane)
  clearPaneFitContinuationRetry(pane)
}

// Reveal fit (minimize→restore, worktree foreground, window wake). resumeRendering
// re-attaches WebGL, whose cell metrics briefly differ from the DOM renderer's, so
// a raw fit can propose a one-column-off grid, reflow xterm, then snap back — and
// xterm's wrap→unwrap is not a perfect inverse, so a diff-painting inline TUI
// (grok, Codex) is left corrupted. So:
//  - pixels changed while hidden → real resize: fit now (also keeps xterm ahead of
//    the async {fit:false} PTY size reassert so it can't forward a stale grid);
//  - pixels unchanged but grid diverged (a direct terminal.resize from snapshot /
//    SSH-reattach, or a DPI change) → repair on a steady grid, so a sustained
//    mismatch refits but a transient metric wobble does not reflow;
//  - grid already correct → leave it alone.
export function fitRevealedPane(pane: ManagedPane): void {
  if (paneFitClientSizeChanged(pane)) {
    safeFit(pane)
    return
  }
  if (!proposedGridMatchesTerminal(pane)) {
    requestStablePaneFit(pane)
    return
  }
  releaseMeasurableFitContinuations(pane)
}
