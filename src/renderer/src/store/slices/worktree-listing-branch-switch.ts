import type { Worktree } from '../../../../shared/worktree/types'

function indexUnambiguousWorktrees(
  worktrees: readonly Worktree[],
  include?: (worktree: Worktree) => boolean
): Map<string, Worktree | null> {
  const byId = new Map<string, Worktree | null>()
  for (const worktree of worktrees) {
    if (include && !include(worktree)) {
      continue
    }
    byId.set(worktree.id, byId.has(worktree.id) ? null : worktree)
  }
  return byId
}

function branchScopedReviewContextMatches(left: Worktree, right: Worktree): boolean {
  return (
    left.linkedPR === right.linkedPR &&
    left.linkedGitLabMR === right.linkedGitLabMR &&
    left.linkedBitbucketPR === right.linkedBitbucketPR &&
    left.linkedAzureDevOpsPR === right.linkedAzureDevOpsPR &&
    left.linkedGiteaPR === right.linkedGiteaPR &&
    left.pushTarget?.remoteName === right.pushTarget?.remoteName &&
    left.pushTarget?.branchName === right.pushTarget?.branchName
  )
}

/** Clear branch-scoped review links before listing merge or git-status can miss the change and leave old PR checks pinned. Route only rows with review context so stale listings still cannot roll newer branch identity back. */
export function routeListingBranchSwitchesThroughGitIdentity(args: {
  requestStarted: readonly Worktree[] | undefined
  current: readonly Worktree[] | undefined
  incoming: Worktree[]
  matchesRefreshHost: (worktree: Worktree) => boolean
  hasBranchScopedReviewContext: (worktree: Worktree) => boolean
  updateWorktreeGitIdentity: (
    worktreeId: string,
    identity: { head?: string; branch?: string | null }
  ) => void
}): Worktree[] {
  const {
    requestStarted,
    current,
    incoming,
    matchesRefreshHost,
    hasBranchScopedReviewContext,
    updateWorktreeGitIdentity
  } = args
  if (!requestStarted?.length || !current?.length) {
    return incoming
  }

  const allLatestById = indexUnambiguousWorktrees(current)
  const startedById = indexUnambiguousWorktrees(requestStarted, matchesRefreshHost)
  const latestById = indexUnambiguousWorktrees(current, matchesRefreshHost)
  let reconciled: Worktree[] | null = null
  for (const [index, worktree] of incoming.entries()) {
    const requestStartedWorktree = startedById.get(worktree.id)
    const existing = latestById.get(worktree.id)
    const isAmbiguousAcrossHosts = allLatestById.get(worktree.id) === null
    if (
      requestStartedWorktree &&
      existing &&
      (existing.branch !== requestStartedWorktree.branch ||
        existing.head !== requestStartedWorktree.head ||
        !branchScopedReviewContextMatches(existing, requestStartedWorktree))
    ) {
      // Why: rejecting the clear alone is insufficient; preserve the newer row
      // so the subsequent listing merge cannot roll its branch and metadata back.
      reconciled ??= [...incoming]
      reconciled[index] = existing
      continue
    }
    if (
      isAmbiguousAcrossHosts ||
      !requestStartedWorktree ||
      !existing ||
      existing.branch === worktree.branch ||
      !hasBranchScopedReviewContext(existing)
    ) {
      continue
    }
    updateWorktreeGitIdentity(worktree.id, {
      head: worktree.head,
      // Empty branch means detached HEAD in listing results; null is the
      // explicit detached signal expected by updateWorktreeGitIdentity.
      branch: worktree.branch === '' ? null : worktree.branch
    })
  }
  return reconciled ?? incoming
}
