import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { observeTerminalImageCellMeasurements } from '../terminal-image-cell-measurements'

export function installPtyResizeEvents(session: ConnectPanePtySession): void {
  const suppressed = (): boolean =>
    session.disposed ||
    session.suppressStructuralReplayPtyResize ||
    session.suppressViewportClaimTerminalResize
  session.onResizeDisposable = session.pane.terminal.onResize(({ cols, rows }) => {
    if (!suppressed()) {
      session.forwardPtyResize(cols, rows)
    }
  })
  if (!session.connectionId && session.runtimeEnvironmentId === null) {
    session.imageCellMeasurementsDisposable = observeTerminalImageCellMeasurements(
      session.pane.terminal,
      () => {
        if (
          suppressed() ||
          !session.transport.isConnected() ||
          !session.isRendererPtyResizeAuthoritative() ||
          session.shouldSuppressDesktopPtyResize()
        ) {
          return false
        }
        session.forwardPtyResize(session.pane.terminal.cols, session.pane.terminal.rows)
        return true
      }
    )
  }
}
