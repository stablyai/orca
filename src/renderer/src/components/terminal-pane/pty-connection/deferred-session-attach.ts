import { useAppStore } from '@/store/index'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { runDeferredSessionReattachChoice } from './reattach/deferred-session-reattach-choice'
import { connectUnservedSshPaneTarget } from './host-ownership/unserved-ssh-pane-connect'
import { startDeferredSessionReattach } from './reattach/deferred-session-reattach-connect'
import {
  hasLegacyRelayBridgedPanesListing,
  isLegacyRelayBridgedTab,
  legacyRelayBridgedPanesListed
} from '../pty-transport/legacy-relay/legacy-relay-bridge-panes'

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
  if (session.runtimeEnvironmentId && !hasLegacyRelayBridgedPanesListing()) {
    void waitForLegacyRelayBridgedPanes(session)
    return
  }
  runDeferredSessionReattachChoice(session)
}

/**
 * COMPAT(legacy-relay-bridge, revisit 2027-01-15): this pane picked its transport before main's
 * first bridged-pane list. Starting it now could resume an agent the older relay still runs, so
 * a pane the list names remounts onto the bridge instead.
 */
async function waitForLegacyRelayBridgedPanes(session: ConnectPanePtySession): Promise<void> {
  await legacyRelayBridgedPanesListed()
  if (session.disposed) {
    return
  }
  const leafId = session.deps.restoredLeafId ?? session.pane.leafId
  if (!session.pendingReplacedPtyId && isLegacyRelayBridgedTab(session.deps.tabId, leafId)) {
    useAppStore.getState().remountTerminalTabForRecovery(session.deps.tabId)
    return
  }
  runDeferredSessionReattachChoice(session)
}
