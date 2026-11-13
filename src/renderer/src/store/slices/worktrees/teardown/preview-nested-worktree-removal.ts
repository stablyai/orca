import { useAppStore } from '@/store'
import {
  resolveWorktreeOperationRoute,
  resolveWorktreeOperationRouteForHost
} from '@/lib/workspace/ownership/worktree-operation-route'
import { callRuntimeRpc } from '../../../../runtime/rpc/calls/runtime-rpc-call'
import { runtimeTargetForOwnerEnvironment } from '../../../../runtime/rpc/targets/runtime-client-target'
import { toRuntimeWorktreeSelector } from '../../../../runtime/rpc/targets/runtime-worktree-selector'
import type { GitWorktreeInfo } from '../../../../../../shared/worktree/types'
import type { WorktreeRemovalTarget } from '../../../../../../shared/worktree/removal'
import { qualifyRuntimeCallHost } from './dispatch-worktree-removal'

/** Asks the workspace's own host which nested worktrees a delete would take with it. */
export async function previewNestedWorktreeRemoval(
  target: WorktreeRemovalTarget,
  unsupportedMessage: string
): Promise<GitWorktreeInfo[]> {
  const state = useAppStore.getState()
  const hostId = target.executionHostId ?? undefined
  const route = hostId
    ? resolveWorktreeOperationRouteForHost(state, target.id, hostId)
    : resolveWorktreeOperationRoute(state, target.id)
  const runtimeTarget = runtimeTargetForOwnerEnvironment(route?.runtimeEnvironmentId ?? null)
  if (runtimeTarget.kind === 'local') {
    const preview = window.api.worktrees.previewNestedRemoval
    if (!preview) {
      throw new Error(unsupportedMessage)
    }
    return preview({ worktreeId: target.id, hostId })
  }
  const runtimeHostId = qualifyRuntimeCallHost(runtimeTarget, hostId)
  return callRuntimeRpc<GitWorktreeInfo[]>(runtimeTarget, 'worktree.previewNestedRemoval', {
    worktree: toRuntimeWorktreeSelector(target.id),
    ...(runtimeHostId ? { hostId: runtimeHostId } : {})
  })
}
