import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { useAppStore } from '../store'
import { unwrapRuntimeRpcResult } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  isWebRuntimeSessionActive
} from './web-runtime-session-environment'
import {
  refreshWebRuntimeSessionTabsSnapshot,
  scheduleRuntimeWorktreeRecoveryRefresh
} from './web-runtime-session-snapshot'

export async function activateWebRuntimeSessionWorktree(args: {
  worktreeId: string
  environmentId?: string | null
}): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)

  try {
    const response = await callEnvironment({
      method: 'worktree.activate',
      params: {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        // Why: notifyClients:false keeps navigation local when this client reaches an older host.
        notifyClients: false,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<unknown>)
    // Why: a restarted HUB can recover its SSH pane after this client's subscription replayed an empty startup snapshot.
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
      expectedEnvironmentPairingRevision: intentOwner.pairingRevision,
      acceptCurrentSnapshot: true
    })
    // Why: HUB reachability can precede its nested SSH relay; bounded owner-scoped re-lists converge without asking the paired client to connect SSH itself.
    scheduleRuntimeWorktreeRecoveryRefresh(
      environmentId,
      args.worktreeId,
      intentOwner.pairingRevision
    )
    return true
  } catch (error) {
    console.warn(
      '[web-runtime-session] failed to activate worktree:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}
