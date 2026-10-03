import { waitForTerminalOutputParsed } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function getHiddenOutputRestoreCompletion(
  session: ConnectPanePtySession
): Promise<void> | null {
  const restore: Promise<void> | null = session.hiddenOutputRestoreInFlight
  if (restore) {
    return restore.then(() => waitForTerminalOutputParsed(session.pane.terminal))
  }
  // Inactive split panes start on the scheduler's next frame.
  return session.hiddenOutputRestoreScheduled
    ? new Promise((resolve) => requestAnimationFrame(() => resolve()))
    : null
}
