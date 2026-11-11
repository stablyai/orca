import { PROCESS_BOUNDARY_GROUND } from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import {
  HOLD_RENDER_UNTIL_RESTORED,
  hasPendingWakeScrollback
} from '@/lib/orca-cloud/cloud-wake-scrollback'

/** A replaced process must not inherit the old one's input modes (#35559). */
export function bindReplacedProcessInputModes(session: ConnectPanePtySession): void {
  // The process whose input modes this xterm may still hold; null once grounded or never stamped.
  session.inputModeOwnerIncarnationId = null

  session.groundInputModesForNewProcess = (): void => {
    session.inputModeOwnerIncarnationId = null
    // WAKE-SCROLLBACK: the ground releases DEC 2026; a woken cloud pane with pre-sleep output to put
    // back re-holds rendering here, at the new terminal's bind, so no clear before its restore is
    // ever painted (the restore releases it).
    session.writeInputModeGround(
      hasPendingWakeScrollback(session.pane.leafId)
        ? `${PROCESS_BOUNDARY_GROUND}${HOLD_RENDER_UNTIL_RESTORED}`
        : PROCESS_BOUNDARY_GROUND
    )
    // The new process never subscribed to mode 2031; a reconnect catch-up would land in its input.
    session.clearPaneMode2031State()
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
