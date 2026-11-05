import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type { GitPushTarget } from '../../../../../../shared/worktree/types'
import type { GitUpstreamStatus } from '../../../../../../shared/git/status/git-status-types'
import type { GitStatusRefreshDeps } from './git-status-refresh'
import { invalidateAutomaticPushTargetUpstreamStatusCache } from './push-target-upstream-refresh-cache'
import {
  claimAutomaticUpstreamRefreshApply,
  shouldApplyAutomaticUpstreamRefresh,
  type AutomaticRefreshOrder
} from './git-status-refresh-ordering'

export async function fetchAndApplyAutomaticUpstreamStatus({
  target,
  worktreeId,
  worktreePath,
  connectionId,
  pushTarget,
  deps,
  order,
  shouldApply
}: {
  /** The worktree owner's transport. */
  target: RuntimeClientTarget
  worktreeId: string
  worktreePath: string
  connectionId?: string
  pushTarget?: GitPushTarget
  deps: GitStatusRefreshDeps
  order: AutomaticRefreshOrder
  shouldApply?: () => boolean
}): Promise<GitUpstreamStatus | null> {
  if (!shouldApplyAutomaticUpstreamRefresh(worktreeId, order, shouldApply)) {
    return null
  }
  const upstreamStatus = await deps.fetchUpstreamStatus(
    worktreeId,
    worktreePath,
    connectionId,
    pushTarget,
    {
      runtimeTarget: target,
      applyUpstreamStatus: false
    }
  )
  if (!upstreamStatus) {
    if (pushTarget) {
      // Invalidate failed publish-target refreshes so older automatic cache entries cannot suppress recovery.
      invalidateAutomaticPushTargetUpstreamStatusCache({
        target,
        worktreeId,
        worktreePath,
        connectionId,
        pushTarget
      })
    }
    return null
  }
  if (!claimAutomaticUpstreamRefreshApply(worktreeId, order, shouldApply)) {
    return null
  }
  deps.setUpstreamStatus(worktreeId, upstreamStatus)
  return upstreamStatus
}
