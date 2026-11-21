import {
  holdPaneForNewerDaemon,
  serverHoldHost,
  type HeldPaneReopenOutcome
} from '../../session-restore/newer-daemon/newer-daemon-hold-state'
import { recordPtyConnectDiagnostic } from '../instrumentation/pty-connect-diagnostics'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

// Clears the saved screen the hold painted so the restore below paints it once.
const CLEAR_HELD_SCREEN = '\x1b[0m\x1b[2J\x1b[3J\x1b[H'

/** Hold a refused restore read-only while a newer daemon may own the session; release reconnects. */
export function holdForNewerDaemon(
  session: ConnectPanePtySession,
  // Null when main refused a saved id the renderer never had; such a pane has no screen to paint.
  sessionId: string | null,
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
  const { runtimeEnvironmentId } = session
  // A paired server's newer build can only be stopped on that server, so its panes can only retry.
  const host = runtimeEnvironmentId ? serverHoldHost(runtimeEnvironmentId) : undefined
  const forget = holdPaneForNewerDaemon(
    session.cacheKey,
    {
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
    },
    host
  )
  session.waitTeardowns.push(forget)
  // Why: a remote pane's layout restore already painted its saved buffer; local panes keep none.
  if (
    !sessionId ||
    runtimeEnvironmentId ||
    session.deps.restoredViewportBlankingPanesRef?.current.has(session.pane.id)
  ) {
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
