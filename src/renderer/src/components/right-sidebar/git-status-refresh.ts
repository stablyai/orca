import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import { getRuntimeGitUpstreamStatus } from '@/runtime/runtime-git-sync-client'
import { getBranchLineTotalMergeBase } from './branch-line-total-request-gate'
import {
  clearAutomaticPushTargetUpstreamStatusCache,
  getCachedAutomaticPushTargetUpstreamStatus,
  invalidateAutomaticPushTargetUpstreamStatusCache,
  storeCachedAutomaticPushTargetUpstreamStatus
} from './push-target-upstream-refresh-cache'
import type { GitStatusResult, GitUpstreamStatus } from '../../../../shared/git-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import {
  beginAutomaticUpstreamRefresh,
  beginStrictUpstreamRefresh,
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
    identity: { head?: string; branch?: string | null }
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

export function clearGitStatusRefreshOrderingForTests(): void {
  clearGitStatusRefreshOrderingStateForTests()
  clearAutomaticPushTargetUpstreamStatusCache()
}

export async function refreshGitStatusForWorktree({
  target,
  worktreeId,
  worktreePath,
  connectionId,
  pushTarget,
  deps,
  request
}: {
  /** The worktree owner's transport. */
  target: RuntimeClientTarget
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
  }
}): Promise<void> {
  const refreshOrder = beginAutomaticUpstreamRefresh(worktreeId)
  // Every status path needs the merge base or polls omitting it will blank the total chip.
  const branchLineTotalMergeBase = getBranchLineTotalMergeBase(worktreeId)
  try {
    const status = await getRuntimeGitStatus(
      {
        target,
        worktreeId,
        worktreePath,
        connectionId
      },
      {
        admissionTier: request?.admissionTier ?? 'status',
        ...(request?.reuseLineStats === true ? { reuseLineStats: true } : {}),
        ...(request?.signal ? { signal: request.signal } : {}),
        ...(branchLineTotalMergeBase ? { branchLineTotalMergeBase } : {})
      }
    )

    if (!claimAutomaticUpstreamRefreshApply(worktreeId, refreshOrder, request?.shouldApply)) {
      return
    }

    deps.setGitStatus(worktreeId, status)
    // Read shell-driven branch changes from git status --branch without another worktree-list poll.
    deps.updateWorktreeGitIdentity(worktreeId, {
      head: status.head,
      // Detached HEAD needs explicit null to clear any stale branch name.
      branch: status.branch ?? (status.head ? null : undefined)
    })
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
        shouldApply: request?.shouldApply
      })
      if (upstreamStatus) {
        // Briefly reuse unchanged automatic comparisons because explicit targets require several Git subprocesses.
        storeCachedAutomaticPushTargetUpstreamStatus(
          { target, worktreeId, worktreePath, connectionId, pushTarget, status },
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
          shouldApply: request?.shouldApply
        })
        return
      }
      if (claimAutomaticUpstreamRefreshApply(worktreeId, refreshOrder, request?.shouldApply)) {
        deps.setUpstreamStatus(worktreeId, status.upstreamStatus)
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
      shouldApply: request?.shouldApply
    })
  } finally {
    finishAutomaticUpstreamRefresh(worktreeId)
  }
}

export async function refreshGitStatusForWorktreeStrict({
  target,
  worktreeId,
  worktreePath,
  connectionId,
  pushTarget,
  deps
}: {
  /** The worktree owner's transport. */
  target: RuntimeClientTarget
  worktreeId: string
  worktreePath: string
  connectionId?: string
  pushTarget?: GitPushTarget
  deps: Omit<GitStatusRefreshDeps, 'fetchUpstreamStatus'> & {
    fetchUpstreamStatus?: GitStatusRefreshDeps['fetchUpstreamStatus']
  }
}): Promise<{ status: GitStatusResult; upstreamStatus: GitUpstreamStatus }> {
  beginStrictUpstreamRefresh(worktreeId)
  clearAutomaticPushTargetUpstreamStatusCache()
  const strictBranchLineTotalMergeBase = getBranchLineTotalMergeBase(worktreeId)
  const status = await getRuntimeGitStatus(
    {
      target,
      worktreeId,
      worktreePath,
      connectionId
    },
    {
      admissionTier: 'interactive',
      // User-triggered reconciliation bypasses automatic polling's no-upstream backoff.
      bypassEffectiveUpstreamNegativeCache: true,
      // Keep the total gate after commit/push so missing totals cannot blank the updated chip.
      ...(strictBranchLineTotalMergeBase
        ? { branchLineTotalMergeBase: strictBranchLineTotalMergeBase }
        : {})
    }
  )

  deps.setGitStatus(worktreeId, status)
  // Read shell-driven branch changes from git status --branch without another worktree-list poll.
  deps.updateWorktreeGitIdentity(worktreeId, {
    head: status.head,
    // Detached HEAD needs explicit null to clear any stale branch name.
    branch: status.branch ?? (status.head ? null : undefined)
  })
  if (pushTarget) {
    // Use Orca's explicit publish target for PR-created worktrees rather than Git's configured upstream.
    const upstreamStatus = await getRuntimeGitUpstreamStatus(
      { target, worktreeId, worktreePath, connectionId },
      pushTarget
    )
    deps.setUpstreamStatus(worktreeId, upstreamStatus)
    return { status, upstreamStatus }
  }
  if (status.upstreamStatus) {
    if (
      status.upstreamStatus.ahead > 0 &&
      status.upstreamStatus.behind > 0 &&
      status.upstreamStatus.behindCommitsArePatchEquivalent === undefined
    ) {
      // Porcelain counts cannot identify stale post-rebase commits; compare first to avoid Sync/Force Push flicker.
      const upstreamStatus = await getRuntimeGitUpstreamStatus(
        { target, worktreeId, worktreePath, connectionId },
        undefined
      )
      deps.setUpstreamStatus(worktreeId, upstreamStatus)
      return { status, upstreamStatus }
    }
    deps.setUpstreamStatus(worktreeId, status.upstreamStatus)
    return { status, upstreamStatus: status.upstreamStatus }
  }
  const upstreamStatus = await getRuntimeGitUpstreamStatus(
    { target, worktreeId, worktreePath, connectionId },
    undefined
  )
  deps.setUpstreamStatus(worktreeId, upstreamStatus)
  return { status, upstreamStatus }
}
