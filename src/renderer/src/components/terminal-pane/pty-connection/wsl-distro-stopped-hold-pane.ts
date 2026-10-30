import { takeRecentWorkspaceSwitchWake } from '@/lib/workspace-switch-user-act'
import { holdPaneForStoppedWslDistro } from '../wsl-distro-stopped-hold-state'
import { recordPtyConnectDiagnostic } from './pty-connect-limits'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { WslDistroHoldState } from '../../../../../shared/wsl-distro-stopped-hold'

// Clears the saved screen the hold painted so the restore below paints it once.
const CLEAR_HELD_SCREEN = '\x1b[0m\x1b[2J\x1b[3J\x1b[H'

/**
 * Whether a local restore may start a stopped WSL distro: only Start, or this pane's first mount
 * after the user's own switch to its workspace (once per switch, while recent). Anything else is
 * passive, so main holds it unless the distro runs. Never on a server, whose host decides.
 */
export function wslRestoreStartArgs(
  session: ConnectPanePtySession,
  userAct: boolean
): { wslPassiveRestore?: true } {
  if (
    session.runtimeEnvironmentId ||
    userAct ||
    takeRecentWorkspaceSwitchWake(session.deps.worktreeId, `pane-restore:${session.cacheKey}`)
  ) {
    return {}
  }
  return { wslPassiveRestore: true }
}

/** Hold the pane read-only with its saved screen until the user's Start reconnects it. */
export function holdForStoppedWslDistro(
  session: ConnectPanePtySession,
  sessionId: string,
  hold: { distro: string; state: WslDistroHoldState },
  reconnect: () => Promise<unknown>
): void {
  recordPtyConnectDiagnostic(`pane=${session.pane.id} -> HELD FOR WSL ${hold.state} ${hold.distro}`)
  const generation = session.transportStreamGeneration
  const terminal = session.pane.terminal
  const isCurrent = (): boolean =>
    !session.disposed &&
    generation === session.transportStreamGeneration &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport
  let held = true
  let paintedScreen = false
  // Why: nothing backs this pane, so keystrokes have nowhere to go.
  terminal.options.disableStdin = true
  const forget = holdPaneForStoppedWslDistro(session.cacheKey, {
    ...hold,
    release: async () => {
      held = false
      if (!isCurrent()) {
        return
      }
      terminal.options.disableStdin = false
      if (paintedScreen) {
        session.writeReplayData(CLEAR_HELD_SCREEN)
      }
      await reconnect()
    }
  })
  session.waitTeardowns.push(forget)
  // The same read-only history read a newer-daemon hold paints, from this machine's daemon history.
  void window.api.pty
    .readNewerDaemonHeldScreen(sessionId)
    .catch(() => null)
    .then((screen) => {
      if (screen && held && isCurrent()) {
        paintedScreen = true
        session.writeReplayData(screen.scrollback)
      }
    })
}
