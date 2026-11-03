import { CONFIRMED_SHELL_MODE_RESET } from '../../../../../shared/terminal-mode-reset-profiles'
import { createPaneForegroundProcessReader } from '../pane-foreground-process-reader'
import { createPaneForegroundReaderDeps } from './pane-foreground-reader-deps'
import { createStaleMouseTrackingGuard } from './stale-mouse-tracking-guard'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function createSessionStaleMouseTrackingGuard(
  session: ConnectPanePtySession
): ReturnType<typeof createStaleMouseTrackingGuard> {
  const readForegroundProcess = createPaneForegroundProcessReader(
    createPaneForegroundReaderDeps(session)
  )
  return createStaleMouseTrackingGuard({
    getBinding: () => {
      const ptyId = session.transport.getPtyId()
      return ptyId ? { ptyId, incarnationId: session.remotePtyIncarnationId ?? null } : null
    },
    isTrackablePtyId: (ptyId) => session.isForegroundTrackingAllowed(ptyId),
    isMouseTrackingArmed: () => session.pane.terminal.modes.mouseTrackingMode !== 'none',
    readConfirmedForeground: (ptyId) => readForegroundProcess(ptyId, true),
    groundToShell: () => session.writeInputModeGround(CONFIRMED_SHELL_MODE_RESET)
  })
}
