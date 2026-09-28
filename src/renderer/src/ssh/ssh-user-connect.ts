import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  connectRuntimeEnvironmentSshTarget,
  resyncRuntimeEnvironmentSshTargets
} from '@/runtime/runtime-environment-ssh-state'
import { isConnectingSshStatus } from '@/ssh/ssh-connection-recoverability'
import { SSH_RECONNECT_UI_TIMEOUT_MS, withUiConnectTimeout } from '@/ssh/ssh-connect-ui-timeout'
import { isSshConnectInFlight, trackSshConnect } from '@/ssh/ssh-connect-in-flight'
import type { SshConnectionStatus } from '../../../shared/ssh-types'

/**
 * A Connect the user clicked on a host control. It is the user's connect, so it also lifts a
 * Disconnect they made earlier; only a user gesture may call it (a ratchet test pins the callers).
 */
export async function connectSshTargetForUser(args: {
  targetId: string
  status: SshConnectionStatus | null
  /** Set when the target belongs to a remote Orca server; routes the connect to that runtime. */
  environmentId: string | null
  connectFailedMessage: string
}): Promise<void> {
  const { targetId, status, environmentId, connectFailedMessage } = args
  if (isSshConnectInFlight(targetId) || isConnectingSshStatus(status)) {
    return
  }
  try {
    if (environmentId) {
      // Bucket state is written inside the helper, mirroring the local path.
      await trackSshConnect(targetId, connectRuntimeEnvironmentSshTarget(environmentId, targetId))
      return
    }
    // Why: track the connect request, not this bounded wait — the backend is still dialing after
    // the UI timeout fires, so releasing here would let the next click raise a second credential
    // prompt.
    const connectState = await withUiConnectTimeout(
      trackSshConnect(targetId, window.api.ssh.connect({ targetId })),
      SSH_RECONNECT_UI_TIMEOUT_MS
    )
    if (connectState) {
      // Why: ssh.connect can resolve before the global state-change IPC lands; the waiting
      // deferred PTY reattach path keys off this renderer store.
      useAppStore.getState().setSshConnectionState(targetId, connectState)
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : connectFailedMessage)
    // Why: a failed connect usually means the renderer's target metadata is stale (target
    // removed, or re-added under a new id). Resync so the control converges to the removed state
    // instead of offering the same failing Connect forever (STA-1468). Apply the target list
    // first — a removed-labels failure must not discard it.
    if (environmentId) {
      void resyncRuntimeEnvironmentSshTargets(environmentId).catch(() => {})
      return
    }
    void (async () => {
      const targets = await window.api.ssh.listTargets()
      useAppStore.getState().setSshTargetsMetadata(targets)
      const removedLabels = await window.api.ssh.listRemovedTargetLabels()
      useAppStore.getState().setRemovedSshTargetLabels(removedLabels)
    })().catch(() => {})
  }
}
