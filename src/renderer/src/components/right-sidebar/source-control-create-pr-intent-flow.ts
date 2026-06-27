import { shouldForcePushWithLeaseForUpstream } from '../../../../shared/git-upstream-status'
import type { HostedReviewCreationEligibility } from '../../../../shared/hosted-review'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../../../shared/hosted-review-refs'
import type { GitStatusEntry, GitUpstreamStatus } from '../../../../shared/types'
import { getStageAllPaths } from './discard-all-sequence'

export type CreatePrIntentRemoteStep = 'publish' | 'push' | 'force_push' | 'blocked' | 'none'

export type CreatePrIntentRunToken = {
  repoId: string
  worktreeId: string
  worktreePath: string
  branch: string
  baseRef?: string | null
  startedAt: number
}

export type CreatePrIntentCurrentTarget = {
  repoId?: string | null
  worktreeId?: string | null
  worktreePath?: string | null
  branch?: string | null
  baseRef?: string | null
}

export function createCreatePrIntentRunToken(input: Omit<CreatePrIntentRunToken, 'startedAt'>) {
  return { ...input, startedAt: Date.now() }
}

function normalizeCreatePrIntentBaseIdentityRef(ref: string | null | undefined): string {
  const trimmed = ref?.trim()
  if (!trimmed) {
    return ''
  }
  // Why: compare bases are local git refs; origin/main and upstream/main must
  // stay distinct even though hosted review APIs receive only branch names.
  if (trimmed.startsWith('refs/remotes/')) {
    return trimmed.slice('refs/remotes/'.length)
  }
  if (trimmed.startsWith('remotes/')) {
    return trimmed.slice('remotes/'.length)
  }
  if (trimmed.startsWith('refs/heads/')) {
    return trimmed.slice('refs/heads/'.length)
  }
  return trimmed
}

export function createPrIntentRunTokenMatches(
  token: CreatePrIntentRunToken,
  current: CreatePrIntentCurrentTarget
): boolean {
  return (
    token.repoId === current.repoId &&
    token.worktreeId === current.worktreeId &&
    token.worktreePath === current.worktreePath &&
    token.branch === current.branch &&
    normalizeCreatePrIntentBaseIdentityRef(token.baseRef) ===
      normalizeCreatePrIntentBaseIdentityRef(current.baseRef)
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

export function resolveCreatePrIntentReviewBase({
  currentBaseRef,
  eligibilityDefaultBaseRef,
  composerBaseRef
}: {
  currentBaseRef?: string | null
  eligibilityDefaultBaseRef?: string | null
  composerBaseRef?: string | null
}): string {
  // Why: the compare-base picker is the user's latest target; eligibility can
  // lag behind while Create PR intent is preparing the branch.
  return normalizeHostedReviewBaseRef(
    currentBaseRef?.trim() || eligibilityDefaultBaseRef?.trim() || composerBaseRef?.trim() || ''
  )
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
