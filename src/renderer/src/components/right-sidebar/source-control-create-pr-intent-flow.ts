import { shouldForcePushWithLeaseForUpstream } from '../../../../shared/git-upstream-status'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import { normalizeHostedReviewHeadRef } from '../../../../shared/hosted-review-refs'
import type { GitStatusEntry, GitUpstreamStatus } from '../../../../shared/types'
import { getStageAllPaths } from './discard-all-sequence'

export type CreatePrIntentRemoteStep = 'publish' | 'push' | 'force_push' | 'blocked' | 'none'

export type CreatePrIntentRunToken = {
  repoId: string
  worktreeId: string
  worktreePath: string
  branch: string
  startedAt: number
}

export type CreatePrIntentCurrentTarget = {
  repoId?: string | null
  worktreeId?: string | null
  worktreePath?: string | null
  branch?: string | null
}

export function createCreatePrIntentRunToken(input: Omit<CreatePrIntentRunToken, 'startedAt'>) {
  return { ...input, startedAt: Date.now() }
}

export function createPrIntentRunTokenMatches(
  token: CreatePrIntentRunToken,
  current: CreatePrIntentCurrentTarget
): boolean {
  return (
    token.repoId === current.repoId &&
    token.worktreeId === current.worktreeId &&
    token.worktreePath === current.worktreePath &&
    token.branch === current.branch
  )
}

export function createPrIntentCurrentTargetConflictsWithToken(
  token: CreatePrIntentRunToken,
  current: CreatePrIntentCurrentTarget
): boolean {
  // Worktree navigation is allowed during a run; only drift within the
  // token's original worktree should be treated as a conflict.
  if (current.worktreeId !== token.worktreeId) {
    return false
  }
  return !createPrIntentRunTokenMatches(token, current)
}

export function createPrIntentGitStatusMatchesToken(
  token: CreatePrIntentRunToken,
  status: { branch?: string | null }
): boolean {
  const branch = normalizeHostedReviewHeadRef(status.branch ?? '')
  return branch.length > 0 && branch === token.branch
}

export function getCreatePrIntentStagePaths(grouped: {
  unstaged: GitStatusEntry[]
  untracked: GitStatusEntry[]
}): string[] {
  return [
    ...getStageAllPaths(grouped.unstaged, 'unstaged'),
    ...getStageAllPaths(grouped.untracked, 'untracked')
  ]
}

export function resolveCreatePrIntentRemoteStep({
  upstreamStatus,
  hostedReviewCreation,
  branchCommitsAhead,
  hasCurrentBranch
}: {
  upstreamStatus: GitUpstreamStatus | undefined
  hostedReviewCreation?: HostedReviewCreationEligibility | null
  branchCommitsAhead?: number
  hasCurrentBranch: boolean
}): CreatePrIntentRemoteStep {
  if (!hasCurrentBranch || !hostedReviewCreation || hostedReviewCreation.canCreate) {
    return 'none'
  }

  if (hostedReviewCreation.blockedReason === 'no_upstream') {
    return branchCommitsAhead && branchCommitsAhead > 0 ? 'publish' : 'blocked'
  }

  if (hostedReviewCreation.blockedReason === 'needs_push') {
    return 'push'
  }

  if (
    hostedReviewCreation.blockedReason === 'needs_sync' &&
    shouldForcePushWithLeaseForUpstream(upstreamStatus)
  ) {
    return 'force_push'
  }

  if (hostedReviewCreation.blockedReason === 'needs_sync') {
    return 'blocked'
  }

  return 'none'
}
