import type { GitHubPRStack, GitHubPRStackEntry } from './pull-request-types'

export type GitHubPRStackMergeScope = {
  count: number
  complete: boolean
  entries: GitHubPRStackEntry[]
}

export type GitHubPRStackMergeBlocker = {
  reason:
    | 'draft'
    | 'closed'
    | 'conflicts'
    | 'changes_requested'
    | 'review_required'
    | 'behind'
    | 'blocked'
  prNumber: number
}

export function isGitHubPRStackMergeQueueRequired(
  reviewMergeQueueRequired: boolean | null | undefined,
  stackMergeQueueRequired: boolean | null | undefined
): boolean {
  return reviewMergeQueueRequired === true || stackMergeQueueRequired === true
}

export function getGitHubPRStackMergeScope(stack: GitHubPRStack): GitHubPRStackMergeScope {
  const entries = [...(stack.entries ?? [])]
    .filter((entry) => entry.position <= stack.position)
    .sort((a, b) => a.position - b.position)
  const count = stack.position
  const complete =
    entries.length === count && entries.every((entry, index) => entry.position === index + 1)
  return { count, complete, entries }
}

function stackEntryBlockerReason(
  entry: GitHubPRStackEntry
): GitHubPRStackMergeBlocker['reason'] | null {
  if (entry.state === 'draft') {
    return 'draft'
  }
  if (entry.state === 'closed') {
    return 'closed'
  }
  if (entry.mergeable === 'CONFLICTING' || entry.mergeStateStatus === 'DIRTY') {
    return 'conflicts'
  }
  if (entry.reviewDecision === 'CHANGES_REQUESTED') {
    return 'changes_requested'
  }
  if (entry.reviewDecision === 'REVIEW_REQUIRED') {
    return 'review_required'
  }
  if (entry.mergeStateStatus === 'BEHIND') {
    return 'behind'
  }
  if (entry.mergeStateStatus === 'BLOCKED') {
    return 'blocked'
  }
  return null
}

export function getGitHubPRStackMergeBlocker(
  scope: GitHubPRStackMergeScope
): GitHubPRStackMergeBlocker | null {
  for (const entry of scope.entries) {
    const reason = stackEntryBlockerReason(entry)
    if (reason) {
      return { reason, prNumber: entry.number }
    }
  }
  return null
}

export type GitHubPRStackMergeDecision = {
  scope: GitHubPRStackMergeScope
  blocker: GitHubPRStackMergeBlocker | null
  usesMergeQueue: boolean
  directMergeAvailable: boolean
}

// A stack merge lands every PR below this one, so the stack's readiness replaces this PR's merge state.
export function resolveGitHubPRStackMergeDecision(args: {
  stack: GitHubPRStack
  reviewMergeQueueRequired: boolean | null | undefined
  stackMergeQueueRequired: boolean | null | undefined
  directMergeAvailable: boolean
}): GitHubPRStackMergeDecision {
  const scope = getGitHubPRStackMergeScope(args.stack)
  const blocker = getGitHubPRStackMergeBlocker(scope)
  const usesMergeQueue = isGitHubPRStackMergeQueueRequired(
    args.reviewMergeQueueRequired,
    args.stackMergeQueueRequired
  )
  return {
    scope,
    blocker,
    usesMergeQueue,
    directMergeAvailable:
      !blocker && (scope.complete || args.directMergeAvailable || usesMergeQueue)
  }
}
