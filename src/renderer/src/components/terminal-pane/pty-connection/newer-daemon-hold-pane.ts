import { holdPaneForNewerDaemon, type HeldPaneReopenOutcome } from '../newer-daemon-hold-state'
import { recordPtyConnectDiagnostic } from './pty-connect-limits'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Clears the saved screen the hold painted so the restore below paints it once.
const CLEAR_HELD_SCREEN = '\x1b[0m\x1b[2J\x1b[3J\x1b[H'

/**
 * Holds a restored local pane main refused to spawn because a newer Orca build's daemon may
 * still run its session: read-only, with its saved screen, until the hold releases it into
 * `reconnect`.
 */
export function holdForNewerDaemon(
  session: ConnectPanePtySession,
  sessionId: string,
  reconnect: () => Promise<HeldPaneReopenOutcome>
): void {
  recordPtyConnectDiagnostic(`pane=${session.pane.id} -> HELD FOR NEWER DAEMON ${sessionId}`)
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
  const forget = holdPaneForNewerDaemon(session.cacheKey, {
    resumable: Boolean(session.buildColdRestoreAgentResumeStartup()),
    release: async () => {
      held = false
      forget()
      if (!isCurrent()) {
        return { reopened: false, agentResumed: false }
      }
      terminal.options.disableStdin = false
      if (paintedScreen) {
        session.writeReplayData(CLEAR_HELD_SCREEN)
      }
      return reconnect()
    }
  })
  session.waitTeardowns.push(forget)
  // Why: a remote pane's layout restore already painted its saved buffer; local panes keep none.
  if (session.deps.restoredViewportBlankingPanesRef?.current.has(session.pane.id)) {
    return
  }
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
