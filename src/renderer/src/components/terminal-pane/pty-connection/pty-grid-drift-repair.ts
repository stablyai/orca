import type { ManagedPaneInternal } from '@/lib/pane-manager/pane-manager-types'
import { requestStablePaneFit } from '@/lib/pane-manager/pane-fit-resize-observer'
import { FOREGROUND_GRID_DRIFT_CHECK_MIN_MS } from './foreground-output-budgets'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPtyGridDriftRepair(session: ConnectPanePtySession): void {
  session.pendingForegroundGridDriftCheckRaf = null
  session.lastForegroundGridDriftCheckAt = Number.NEGATIVE_INFINITY
  session.readProposedTerminalGrid = (): { cols: number; rows: number } | null => {
    try {
      const proposed = session.pane.fitAddon.proposeDimensions()
      if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) {
        return null
      }
      return proposed
    } catch {
      return null
    }
  }
  session.terminalGridDriftedFromFit = (): boolean => {
    const proposed = session.readProposedTerminalGrid()
    return Boolean(
      proposed &&
      (session.pane.terminal.cols !== proposed.cols || session.pane.terminal.rows !== proposed.rows)
    )
  }
  session.scheduleForegroundGridDriftCheck = (force = false): void => {
    if (
      session.disposed ||
      !session.deps.isVisibleRef.current ||
      session.shouldSuppressDesktopPtyResize() ||
      session.pendingForegroundGridDriftCheckRaf !== null ||
      (!force && session.terminalSelectionFitGuard?.isActive())
    ) {
      return
    }
    const now = performance.now()
    if (
      !force &&
      now - session.lastForegroundGridDriftCheckAt < FOREGROUND_GRID_DRIFT_CHECK_MIN_MS
    ) {
      return
    }
    session.lastForegroundGridDriftCheckAt = now
    session.pendingForegroundGridDriftCheckRaf = requestAnimationFrame(() => {
      session.pendingForegroundGridDriftCheckRaf = null
      if (
        session.disposed ||
        !session.deps.isVisibleRef.current ||
        session.shouldSuppressDesktopPtyResize() ||
        session.terminalSelectionFitGuard?.isActive() ||
        !session.terminalGridDriftedFromFit()
      ) {
        return
      }
      requestStablePaneFit(session.pane as ManagedPaneInternal, () =>
        session.ptySizeReassertion.request({ fit: false })
      )
    })
  }
}
