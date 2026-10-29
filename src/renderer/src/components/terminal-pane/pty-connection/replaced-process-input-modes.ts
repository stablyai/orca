import { PROCESS_BOUNDARY_GROUND } from '../../../../../shared/terminal-mode-reset-profiles'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** A replaced process must not inherit the old one's input modes (#35559). */
export function bindReplacedProcessInputModes(session: ConnectPanePtySession): void {
  // The process whose input modes this xterm may still hold; null once grounded or never stamped.
  session.inputModeOwnerIncarnationId = null

  session.groundInputModesForNewProcess = (): void => {
    session.inputModeOwnerIncarnationId = null
    session.writeInputModeGround(PROCESS_BOUNDARY_GROUND)
  }

  // Call before the process's replay is written, so its own bytes re-arm only what it set.
  session.noteBoundProcessIncarnation = (incarnationId: string | null | undefined): void => {
    if (!incarnationId || incarnationId === session.inputModeOwnerIncarnationId) {
      return
    }
    if (session.inputModeOwnerIncarnationId !== null) {
      session.groundInputModesForNewProcess()
    }
    session.inputModeOwnerIncarnationId = incarnationId
  }
}
