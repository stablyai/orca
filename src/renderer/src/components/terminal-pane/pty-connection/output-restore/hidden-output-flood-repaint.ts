import { onTerminalScrollIntentFollowOutput } from '@/lib/pane-manager/terminal-scroll-intent'
import { shouldWritePtyOutputForeground } from '../output/foreground-output-visibility'
import { HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS } from './hidden-output-restore-limits'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function bindHiddenOutputFloodRepaint(session: ConnectPanePtySession): void {
  function isHiddenOutputRestoreFloodSuppressed(): boolean {
    return Date.now() < session.hiddenOutputRestoreFloodSuppressedUntil
  }

  // Own-restore backpressure markers must defer to quiet repaint rather than re-arm the rc.7.perf fetch loop.
  session.isForegroundRestoreBackpressureContext = function (): boolean {
    return (
      shouldWritePtyOutputForeground(session.deps.isVisibleRef.current) &&
      (session.hiddenOutputRestoreInFlight !== null || isHiddenOutputRestoreFloodSuppressed())
    )
  }

  session.clearHiddenOutputRestoreFloodRepaintTimer = function (): void {
    session.cancelHiddenOutputRestoreFloodRepaintPark?.()
    session.cancelHiddenOutputRestoreFloodRepaintPark = null
    if (session.hiddenOutputRestoreFloodRepaintTimer === null) {
      return
    }
    clearTimeout(session.hiddenOutputRestoreFloodRepaintTimer)
    session.hiddenOutputRestoreFloodRepaintTimer = null
  }
  session.cleanupHiddenOutputRestoreFloodRepaint = session.clearHiddenOutputRestoreFloodRepaintTimer

  // Why: the repaint discards the buffer and replays a full snapshot, which repositions the viewport; a user reading scrollback must not be yanked to the bottom, so hold it until their own scroll intent returns to follow-output.
  session.repaintAfterFloodWhenFollowingOutput = function (ptyId: string): void {
    session.cancelHiddenOutputRestoreFloodRepaintPark?.()
    session.cancelHiddenOutputRestoreFloodRepaintPark = null
    let repainted = false
    const cancelPark = onTerminalScrollIntentFollowOutput(session.pane.terminal, () => {
      repainted = true
      session.cancelHiddenOutputRestoreFloodRepaintPark = null
      if (session.disposed || session.transport.getPtyId() !== ptyId) {
        return
      }
      session.markHiddenOutputRestoreNeeded()
    })
    if (!repainted) {
      session.cancelHiddenOutputRestoreFloodRepaintPark = cancelPark
    }
  }

  session.extendHiddenOutputRestoreFloodSuppression = function (): void {
    session.hiddenOutputRestoreFloodSuppressedUntil =
      Date.now() + HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS
  }

  session.resetHiddenOutputRestoreFloodSuppression = function (): void {
    session.hiddenOutputRestoreFloodSuppressedUntil = 0
    session.clearHiddenOutputRestoreFloodRepaintTimer()
  }
}
