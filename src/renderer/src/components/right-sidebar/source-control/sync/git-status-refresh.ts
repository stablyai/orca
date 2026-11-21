import { getRuntimeGitStatus } from '@/runtime/source-control/git/runtime-git-status-client'
import { getBranchLineTotalMergeBase } from './branch-line-total-request-gate'
import {
  clearAutomaticPushTargetUpstreamStatusCache,
  getCachedAutomaticPushTargetUpstreamStatus,
  invalidateAutomaticPushTargetUpstreamStatusCache,
  storeCachedAutomaticPushTargetUpstreamStatus
} from './push-target-upstream-refresh-cache'
import type {
  GitStatusResult,
  GitUpstreamStatus
} from '../../../../../../shared/git/status/git-status-types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { GitPushTarget } from '../../../../../../shared/worktree/types'
import {
  beginAutomaticUpstreamRefresh,
  claimAutomaticUpstreamRefreshApply,
  clearGitStatusRefreshOrderingStateForTests,
  finishAutomaticUpstreamRefresh,
  shouldApplyAutomaticUpstreamRefresh,
  type AutomaticRefreshOrder
} from './git-status-refresh-ordering'

export type GitStatusRefreshDeps = {
  setGitStatus: (worktreeId: string, status: GitStatusResult) => void
  updateWorktreeGitIdentity: (
    worktreeId: string,
    identity: { head?: string; branch?: string | null },
    ownerHostId: ExecutionHostId | null
  ) => void
  setUpstreamStatus: (worktreeId: string, status: GitUpstreamStatus) => void
  fetchUpstreamStatus: (
    worktreeId: string,
    worktreePath: string,
    connectionId?: string,
    pushTarget?: GitPushTarget,
    options?: {
      runtimeTarget?: RuntimeClientTarget | null
      applyUpstreamStatus?: boolean
    }
  ) => Promise<GitUpstreamStatus | null>
}

async function fetchAndApplyAutomaticUpstreamStatus({
  target,
  worktreeId,
  worktreePath,
  connectionId,
  pushTarget,
  deps,
  order,
  head,
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
  /** HEAD the status read observed; tags the comparison so stale pushes are not claimed for a moved HEAD. */
  head?: string
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
  const tagged = head ? { ...upstreamStatus, head } : upstreamStatus
  deps.setUpstreamStatus(worktreeId, tagged)
  return tagged
}

export function clearGitStatusRefreshOrderingForTests(): void {
  clearGitStatusRefreshOrderingStateForTests()
  clearAutomaticPushTargetUpstreamStatusCache()
}

// Stored comparisons carry the HEAD they were computed for so consumers can reject stale pushes.
export function tagUpstreamWithStatusHead(
  status: GitStatusResult,
  upstreamStatus: GitUpstreamStatus
): GitUpstreamStatus {
  return status.head ? { ...upstreamStatus, head: status.head } : upstreamStatus
}

export async function refreshGitStatusForWorktree({
  target,
  ownerHostId,
  worktreeId,
  worktreePath,
  connectionId,
  pushTarget,
  deps,
  request
}: {
  /** The worktree owner's transport. */
  target: RuntimeClientTarget
  /** The copy `target` answers for, read when the request starts. */
  ownerHostId: ExecutionHostId | null
  worktreeId: string
  worktreePath: string
  connectionId?: string
  pushTarget?: GitPushTarget
  deps: GitStatusRefreshDeps
  request?: {
    admissionTier?: 'interactive' | 'status' | 'background'
    reuseLineStats?: boolean
    signal?: AbortSignal
    shouldApply?: () => boolean
    onStatusAccepted?: (status: GitStatusResult) => void
    wakeWslDistro?: boolean
  }
}): Promise<void> {
  const refreshOrder = beginAutomaticUpstreamRefresh(worktreeId)
  // Every status path needs the merge base or polls omitting it will blank the total chip.
  const branchLineTotalMergeBase = getBranchLineTotalMergeBase(worktreeId)
  try {
    const status = await getRuntimeGitStatus(
      { target, worktreeId, worktreePath, connectionId },
      {
        admissionTier: request?.admissionTier ?? 'status',
        ...(request?.reuseLineStats === true ? { reuseLineStats: true } : {}),
        ...(request?.signal ? { signal: request.signal } : {}),
        ...(branchLineTotalMergeBase ? { branchLineTotalMergeBase } : {}),
        ...(request?.wakeWslDistro ? { wakeWslDistro: true } : {})
      }
    )

    if (!claimAutomaticUpstreamRefreshApply(worktreeId, refreshOrder, request?.shouldApply)) {
      return
    }

    deps.setGitStatus(worktreeId, status)
    // Read shell-driven branch changes from git status --branch without another worktree-list poll.
    deps.updateWorktreeGitIdentity(
      worktreeId,
      {
        head: status.head,
        // Detached HEAD needs explicit null to clear any stale branch name.
        branch: status.branch ?? (status.head ? null : undefined)
      },
      ownerHostId
    )
    request?.onStatusAccepted?.(status)
    if (pushTarget) {
      // Use Orca's explicit publish target for PR-created worktrees rather than Git's configured upstream.
      const cachedUpstreamStatus = getCachedAutomaticPushTargetUpstreamStatus({
        target,
        worktreeId,
        worktreePath,
        connectionId,
        pushTarget,
        status
      })
      if (cachedUpstreamStatus) {
        // Cache hits skip subprocesses; retain fresher status already written by push/fetch actions.
        return
      }
      const upstreamStatus = await fetchAndApplyAutomaticUpstreamStatus({
        target,
        worktreeId,
        worktreePath,
        connectionId,
        pushTarget,
        deps,
        order: refreshOrder,
        head: status.head,
        shouldApply: request?.shouldApply
      })
      if (upstreamStatus) {
        // Briefly reuse unchanged automatic comparisons because explicit targets require several Git subprocesses.
        storeCachedAutomaticPushTargetUpstreamStatus(
          {
            target,
            worktreeId,
            worktreePath,
            connectionId,
            pushTarget,
            status
          },
          upstreamStatus
        )
      }
      return
    }
    if (status.upstreamStatus) {
      if (
        status.upstreamStatus.ahead > 0 &&
        status.upstreamStatus.behind > 0 &&
        status.upstreamStatus.behindCommitsArePatchEquivalent === undefined
      ) {
        // Porcelain counts cannot identify stale post-rebase commits; compare first to avoid Sync/Force Push flicker.
        await fetchAndApplyAutomaticUpstreamStatus({
          target,
          worktreeId,
          worktreePath,
          connectionId,
          deps,
          order: refreshOrder,
          head: status.head,
          shouldApply: request?.shouldApply
        })
        return
      }
      if (claimAutomaticUpstreamRefreshApply(worktreeId, refreshOrder, request?.shouldApply)) {
        deps.setUpstreamStatus(worktreeId, tagUpstreamWithStatusHead(status, status.upstreamStatus))
      }
      return
    }
    await fetchAndApplyAutomaticUpstreamStatus({
      target,
      worktreeId,
      worktreePath,
      connectionId,
      pushTarget,
      deps,
      order: refreshOrder,
      head: status.head,
      shouldApply: request?.shouldApply
    })
  } finally {
    finishAutomaticUpstreamRefresh(worktreeId)
  }
}

export type RefreshGitStatusStrictDeps = Omit<GitStatusRefreshDeps, 'fetchUpstreamStatus'> & {
  fetchUpstreamStatus?: GitStatusRefreshDeps['fetchUpstreamStatus']
}
