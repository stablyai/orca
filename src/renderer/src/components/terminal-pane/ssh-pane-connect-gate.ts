import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { isRuntimeOwnedSshTargetId } from '../../../../shared/execution-host'

export type SshPaneConnectGate = {
  /** Session the pane should reattach after connecting (null → fresh spawn). */
  pendingSessionId: string | null
  /** True when the pane must run the deferred-connect flow before any spawn. */
  enterDeferredFlow: boolean
  sshConnected: boolean
}

// Why: an SSH pane must never call pty:spawn while its target's provider is
// unregistered — main rejects with "No PTY provider" and the pane strands
// behind an error toast that never retries. This decides, from restore
// bookkeeping plus the live connection state, whether the pane needs the
// deferred-connect flow first and which session it should reattach.
export function resolveSshPaneConnectGate(input: {
  connectionId: string
  sshStatus: string | undefined
  isDeferredTarget: boolean
  restoredLeafSessionId: string | null
  deferredTabSessionId: string | undefined
  tabPtyId: string | null | undefined
  hasLeafSessionMap: boolean
}): SshPaneConnectGate {
  const sshConnected = input.sshStatus === 'connected'
  // Why: the deferred maps can miss a tab (e.g. activeConnectionIdsAtShutdown
  // wasn't persisted, so restore registered no deferred target). The tab's own
  // restored app SSH pty id still names the session — reattach it rather than
  // spawning a replacement shell. Skipped when a per-leaf session map exists:
  // leaves carry their own ids and the tab-level id must not be attached by
  // every leaf of a split.
  const fallbackTabSessionId =
    !sshConnected &&
    !input.hasLeafSessionMap &&
    input.tabPtyId &&
    parseAppSshPtyId(input.tabPtyId)?.connectionId === input.connectionId
      ? input.tabPtyId
      : null
  const pendingSessionId =
    input.restoredLeafSessionId ?? input.deferredTabSessionId ?? fallbackTabSessionId ?? null
  // Why: runtime-owned targets are excluded — their relay health is owned by
  // the runtime layer and users cannot connect to them directly.
  const needsConnectBeforeSpawn = !sshConnected && !isRuntimeOwnedSshTargetId(input.connectionId)
  return {
    pendingSessionId,
    enterDeferredFlow:
      Boolean(pendingSessionId) || input.isDeferredTarget || needsConnectBeforeSpawn,
    sshConnected
  }
}
