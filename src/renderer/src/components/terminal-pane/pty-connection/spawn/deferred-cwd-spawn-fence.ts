import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function releaseDeferredCwdFence(session: ConnectPanePtySession): void {
  if (!session.transport.getPtyId()) {
    session.transport.abandonPreconnectInput?.()
    try {
      session.deps.onDeferredCwdSpawnFailed?.()
    } catch {
      // Cleanup must not turn a settled spawn into an unhandled rejection.
    }
  }
}
