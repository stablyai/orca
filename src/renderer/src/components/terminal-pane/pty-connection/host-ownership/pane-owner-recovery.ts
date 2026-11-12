import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function isPaneOwnerRefusal(message: string): boolean {
  return (
    message.includes('terminal_pane_owner_changed') ||
    message.includes('terminal_pane_owner_unverified')
  )
}

/** Refusals that keep the pane's saved session; Retry asks the same terminal again. */
export function isRetryablePaneRefusal(message: string): boolean {
  return isPaneOwnerRefusal(message) || message.includes('terminal_history_unavailable')
}

export function armPaneOwnerRetry(
  session: ConnectPanePtySession,
  generation: number,
  retry: () => unknown
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
    void retry()
    return true
  }
}
