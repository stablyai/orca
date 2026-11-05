import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function isPaneOwnerRefusal(message: string): boolean {
  return (
    message.includes('terminal_pane_owner_changed') ||
    message.includes('terminal_pane_owner_unverified')
  )
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
