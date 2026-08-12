import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { safeFit } from '@/lib/pane-manager/pane-fit'
import { deferTerminalGeometryMutationDuringRebuild } from '@/lib/pane-manager/terminal-scroll-intent-rebuild'

type DesktopFitFallbackDimensions = {
  cols: number
  rows: number
  priorCols?: number | null
  priorRows?: number | null
  shouldApply?: () => boolean
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
