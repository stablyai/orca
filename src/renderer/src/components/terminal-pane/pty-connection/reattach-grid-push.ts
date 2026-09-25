import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installReattachGridPush(session: ConnectPanePtySession): void {
  // Why built here and not inside session.handleReattachResult: a hidden pane parks this until it is
  // revealed, and a closure created in that scope would pin the whole reattach payload
  // (snapshot/replay/coldRestore bytes) for as long as the pane stays hidden. Taking the
  // generation and pty id by value keeps only connection-level state alive.
  session.createReattachGridPush = (
    attemptGeneration: number,
    reattachPtyId: string
  ): { shouldContinue: () => boolean; continuation: () => void } => {
    const incarnationId = session.remotePtyIncarnationId
    const isCurrent = (): boolean =>
      !session.disposed &&
      session.remotePtyIncarnationId === incarnationId &&
      attemptGeneration === session.transportStreamGeneration &&
      session.transport.getPtyId() === reattachPtyId
    return {
      shouldContinue: isCurrent,
      continuation: () => {
        if (!isCurrent()) {
          return
        }
        // Why re-checked at fire time: the caller's pre-check cannot see a mobile takeover that
        // lands while the pane waits for a box, and transport.resize here bypasses
        // forwardPtyResize's own suppression.
        if (session.shouldSuppressDesktopPtyResize()) {
          return
        }
        const reattachCols = session.pane.terminal.cols
        const reattachRows = session.pane.terminal.rows
        if (reattachCols > 0 && reattachRows > 0) {
          session.transport.resize(reattachCols, reattachRows)
        }
        if (!isRemoteRuntimePtyId(reattachPtyId)) {
          window.api.pty.signal(reattachPtyId, 'SIGWINCH')
        }
        if (session.deps.isVisibleRef.current) {
          session.ptySizeReassertion.request({ fit: false })
        }
      }
    }
  }
}
