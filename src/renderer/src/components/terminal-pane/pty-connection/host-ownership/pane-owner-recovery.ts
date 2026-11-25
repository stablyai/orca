import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import type { PendingStartupCommand } from '../startup/fresh-spawn-types'
import { skipPaneResumeOwnedElsewhere } from '../startup/pane-resume-owned-elsewhere'

export function isPaneOwnerRefusal(message: string): boolean {
  return (
    message.includes('terminal_pane_owner_changed') ||
    message.includes('terminal_pane_owner_unverified')
  )
}

export function armPaneOwnerRetry(
  session: ConnectPanePtySession,
  generation: number,
  retry: () => unknown,
  startupOverride?: PendingStartupCommand | null
): void {
  if (session.runtimeEnvironmentId) {
    return
  }
  session.transport.retryRecovery = () => {
    if (
      session.disposed ||
      generation !== session.transportStreamGeneration ||
      session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport
    ) {
      return false
    }
    if (skipPaneResumeOwnedElsewhere(session, startupOverride)) {
      return true
    }
    void retry()
    return true
  }
}
