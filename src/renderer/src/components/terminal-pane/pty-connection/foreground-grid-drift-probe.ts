import type { ManagedPaneInternal } from '@/lib/pane-manager/pane-manager-types'
import { requestStablePaneFit } from '@/lib/pane-manager/pane-fit-resize-observer'
import {
  FOREGROUND_GRID_DRIFT_CHECK_MIN_MS,
  FOREGROUND_GRID_DRIFT_SETTLED_RECHECK_MS
} from './foreground-output-budgets'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Repairs xterm grids that drifted from the fit without a pane resize, throttled on foreground output.
export function installForegroundGridDriftProbe(session: ConnectPanePtySession): void {
  session.pendingForegroundGridDriftCheckRaf = null
  session.lastForegroundGridDriftCheckAt = Number.NEGATIVE_INFINITY
  // Why: proposeDimensions() forces style/layout; after a matching probe, wait for a geometry signal or the backstop.
  session.foregroundGridDriftProbeSettled = false
  session.foregroundGridDriftTrailingTimer = null
  session.foregroundGridDriftTrailingDeadline = Number.POSITIVE_INFINITY
  session.clearForegroundGridDriftTrailingProbe = (): void => {
    if (session.foregroundGridDriftTrailingTimer !== null) {
      clearTimeout(session.foregroundGridDriftTrailingTimer)
      session.foregroundGridDriftTrailingTimer = null
    }
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
    const minIntervalMs = session.foregroundGridDriftProbeSettled
      ? FOREGROUND_GRID_DRIFT_SETTLED_RECHECK_MS
      : FOREGROUND_GRID_DRIFT_CHECK_MIN_MS
    const elapsedMs = now - session.lastForegroundGridDriftCheckAt
    if (!force && elapsedMs < minIntervalMs) {
      // Why: the last write in a burst may land inside the interval; one trailing probe keeps drift from sticking once output stops.
      const deadline = session.lastForegroundGridDriftCheckAt + minIntervalMs
      if (
        session.foregroundGridDriftTrailingTimer === null ||
        deadline < session.foregroundGridDriftTrailingDeadline
      ) {
        session.clearForegroundGridDriftTrailingProbe()
        session.foregroundGridDriftTrailingDeadline = deadline
        session.foregroundGridDriftTrailingTimer = setTimeout(
          () => {
            session.foregroundGridDriftTrailingTimer = null
            session.scheduleForegroundGridDriftCheck()
          },
          Math.ceil(minIntervalMs - elapsedMs)
        )
      }
      return
    }
    session.clearForegroundGridDriftTrailingProbe()
    session.lastForegroundGridDriftCheckAt = now
    session.pendingForegroundGridDriftCheckRaf = requestAnimationFrame(() => {
      session.pendingForegroundGridDriftCheckRaf = null
      if (
        session.disposed ||
        !session.deps.isVisibleRef.current ||
        session.shouldSuppressDesktopPtyResize() ||
        session.terminalSelectionFitGuard?.isActive()
      ) {
        return
      }
      const drift = session.measureTerminalGridFitDrift()
      session.foregroundGridDriftProbeSettled = drift === 'matched'
      if (drift !== 'drifted') {
        return
      }
      requestStablePaneFit(session.pane as ManagedPaneInternal, () =>
        session.ptySizeReassertion.request({ fit: false })
      )
    })
  }
}
