import type { AppState } from '@/store/types'
import { selectWorktreeHostConnectionPhase } from '@/lib/workspace/ownership/worktree-host-connection-phase'
import { runtimeHostConnectionStateForEntry } from '@/runtime/hosts/connections/runtime-host-connection-state'
import { isConnectedRuntimeHostState } from '../../../../../../shared/remote-runtime/host-status/runtime-host-connection-state'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

/**
 * Whether a fork's "Forked from" divider can open its source now. A fork and its source share a
 * workspace and host, so this asks whether that host is reachable: the workspace's SSH target,
 * when this client dials one, must be connected, and a chat a remote runtime owns needs that
 * runtime connected. A local workspace (or a runtime-owned target) has no SSH dial of its own.
 */
export function selectNativeChatForkSourceOpenable(
  state: AppState,
  worktreeId: string,
  target: RuntimeClientTarget
): boolean {
  const { phase } = selectWorktreeHostConnectionPhase(state, worktreeId)
  if (phase !== 'local' && phase !== 'connected') {
    return false
  }
  return (
    target.kind === 'local' ||
    isConnectedRuntimeHostState(
      runtimeHostConnectionStateForEntry(
        state.runtimeStatusByEnvironmentId?.get(target.environmentId)
      )
    )
  )
}
