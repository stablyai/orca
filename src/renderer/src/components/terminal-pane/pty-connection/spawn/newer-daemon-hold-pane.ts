import {
  holdPaneForNewerDaemon,
  type HeldPaneReopenOutcome
} from '../../session-restore/newer-daemon/newer-daemon-hold-state'
import { recordPtyConnectDiagnostic } from '../instrumentation/pty-connect-diagnostics'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { holdRetainedTerminalHistory } from '../reattach/retained-terminal-history'

/** Hold refused local restores read-only with saved output while a newer daemon may own the session; release reconnects. */
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
  const image = holdRetainedTerminalHistory(session, sessionId)
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
      return reconnect()
    }
  })
  session.waitTeardowns.push(forget)
  // Why: a remote pane's layout restore already painted its saved buffer; local panes keep none.
  if (session.deps.restoredViewportBlankingPanesRef?.current.has(session.pane.id)) {
    image.painted = true
    return
  }
  void window.api.pty
    .readNewerDaemonHeldScreen(sessionId)
    .catch(() => null)
    .then((screen) => {
      if (screen && held && isCurrent() && !image.painted) {
        image.painted = true
        session.writeReplayData(screen.scrollback)
      }
    })
}
