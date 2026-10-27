import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { runDeferredSessionReattachChoice } from './deferred-session-reattach-choice'
import { connectUnservedSshPaneTarget } from './unserved-ssh-pane-connect'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'

export function runDeferredSessionAttach(session: ConnectPanePtySession): void {
  // COMPAT(legacy-relay-bridge, revisit 2027-01-15): reattach the relay-era terminal it still runs.
  if (session.legacyRelayBridgePtyId && !session.pendingReplacedPtyId) {
    startDeferredSessionReattach(session, session.legacyRelayBridgePtyId)
    return
  }
  if (session.unservedSshTargetId) {
    connectUnservedSshPaneTarget(session, session.unservedSshTargetId)
    return
  }
  runDeferredSessionReattachChoice(session)
}
