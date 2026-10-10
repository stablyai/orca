import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { useAppStore } from '../store'
import type { WorktreeSelectionOwner } from '../../../shared/worktree-selection-owner'
import { isCurrentWebRuntimeSessionWorktreeOwner } from './web-runtime-session-worktree-owner'
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
  owner?: WorktreeSelectionOwner
}): Promise<boolean> {
  const environmentId =
    args.environmentId?.trim() ??
    useAppStore.getState().settings?.activeRuntimeEnvironmentId?.trim() ??
    null
  if (!environmentId || !isWebRuntimeSessionActive(environmentId)) {
    return false
  }
  if (
    args.owner &&
    (!args.owner.instanceId ||
      !isCurrentWebRuntimeSessionWorktreeOwner(useAppStore.getState(), environmentId, args.owner))
  ) {
    return false
  }
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)

  try {
    const response = await callEnvironment({
      method: 'worktree.activate',
      params: {
        worktree: toRuntimeWorktreeSelector(
          args.worktreeId,
          args.owner?.instanceId
            ? { executionHostId: args.owner.executionHostId, instanceId: args.owner.instanceId }
            : undefined
        ),
        // Why: notifyClients:false keeps navigation local when this client reaches an older host.
        notifyClients: false,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
    unwrapRuntimeRpcResult(response as RuntimeRpcResponse<unknown>)
    if (
      args.owner &&
      !isCurrentWebRuntimeSessionWorktreeOwner(useAppStore.getState(), environmentId, args.owner)
    ) {
      return false
    }
    // Why: a restarted HUB can recover its SSH pane after this client's subscription replayed an empty startup snapshot.
    await refreshWebRuntimeSessionTabsSnapshot(environmentId, args.worktreeId, {
      expectedEnvironmentPairingRevision: intentOwner.pairingRevision,
      acceptCurrentSnapshot: true,
      errorMode: 'throw',
      ...(args.owner ? { owner: args.owner } : {})
    })
    // Why: HUB reachability can precede its nested SSH relay; bounded owner-scoped re-lists converge without asking the paired client to connect SSH itself.
    scheduleRuntimeWorktreeRecoveryRefresh(
      environmentId,
      args.worktreeId,
      intentOwner.pairingRevision,
      args.owner
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
