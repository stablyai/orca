import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { safeFit } from '@/lib/pane-manager/pane-fit'
import { forceRepaintThroughRenderPause } from '@/lib/pane-manager/terminal-render-pause-release'
import { deferTerminalGeometryMutationDuringRebuild } from '@/lib/pane-manager/terminal-scroll-intent-rebuild'

type DesktopFitFallbackDimensions = {
  cols: number
  rows: number
  priorCols?: number | null
  priorRows?: number | null
  shouldApply?: () => boolean
}

// Why: mobile-fit restore can return cols×rows while xterm's WebGL/paused
// renderer keeps the phone-sized canvas until a scroll. Present the live
// buffer after geometry lands; do not change the hold policy.
export function refreshDesktopPaneContents(pane: Pick<ManagedPane, 'terminal'>): void {
  if (pane.terminal.rows <= 0) {
    return
  }
  if (!forceRepaintThroughRenderPause(pane.terminal)) {
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  }
}

export function fitAndRefreshDesktopPane(pane: ManagedPane): void {
  safeFit(pane)
  refreshDesktopPaneContents(pane)
}

export function applyDesktopFitFallbackAfterReplay(
  pane: ManagedPane,
  dimensions: DesktopFitFallbackDimensions
): void {
  const applyFallback = (): void => {
    if (dimensions.shouldApply?.() === false) {
      return
    }
    safeFit(pane)
    const stuckAtPriorGrid =
      dimensions.priorCols != null &&
      dimensions.priorRows != null &&
      pane.terminal.cols === dimensions.priorCols &&
      pane.terminal.rows === dimensions.priorRows
    if (stuckAtPriorGrid && dimensions.cols > 0 && dimensions.rows > 0) {
      pane.terminal.resize(dimensions.cols, dimensions.rows)
    }
    refreshDesktopPaneContents(pane)
  }
  // Why: the server dimensions are only a fallback; source-dimension replay
  // must parse and restore its viewport before this can reflow xterm.
  if (
    !deferTerminalGeometryMutationDuringRebuild(
      pane.terminal,
      'desktop-fit-fallback',
      applyFallback
    )
  ) {
    applyFallback()
  }
}
