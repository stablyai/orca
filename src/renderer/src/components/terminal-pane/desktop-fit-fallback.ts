import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { safeFit, safeFitAndThen } from '@/lib/pane-manager/pane-fit'
import { requestFullViewportPresent } from '@/lib/pane-manager/terminal-render-pause-release'
import { deferTerminalGeometryMutationDuringRebuild } from '@/lib/pane-manager/terminal-scroll-intent-rebuild'

type DesktopFitFallbackDimensions = {
  cols: number
  rows: number
  priorCols?: number | null
  priorRows?: number | null
  shouldApply?: () => boolean
}

function refreshDesktopPaneContents(pane: Pick<ManagedPane, 'terminal'>): void {
  if (pane.terminal.rows > 0 && !requestFullViewportPresent(pane.terminal)) {
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  }
}

export function fitAndRefreshDesktopPane(pane: ManagedPane, shouldApply: () => boolean): void {
  const applyFit = (): void => {
    if (!shouldApply()) {
      return
    }
    safeFitAndThen(pane, 'desktop-fit-refresh', () => refreshDesktopPaneContents(pane), {
      shouldContinue: shouldApply,
      retryIfUnmeasurable: true,
      deferIfHidden: true
    })
  }
  if (!deferTerminalGeometryMutationDuringRebuild(pane.terminal, 'desktop-fit-refresh', applyFit)) {
    applyFit()
  }
}

export function applyDesktopFitFallbackAfterReplay(
  pane: ManagedPane,
  dimensions: DesktopFitFallbackDimensions
): void {
  const applyFallback = (): void => {
    if (dimensions.shouldApply?.() === false) {
      return
    }
    const rect = pane.container.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      return
    }
    safeFit(pane)
    if (dimensions.shouldApply?.() === false) {
      return
    }
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
  // Parse source-dimension replay before fallback fitting can reflow xterm.
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
