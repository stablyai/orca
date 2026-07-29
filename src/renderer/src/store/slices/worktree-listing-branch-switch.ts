import type { Worktree } from '../../../../shared/types'

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

/**
 * Route branch switches observed by a worktree-listing refresh through
 * `updateWorktreeGitIdentity` before the listing is merged into the store.
 *
 * Why: a terminal branch switch is observed by two independent refresh paths —
 * the git-status identity path (which clears branch-scoped review links) and
 * the worktree-listing path (which rehydrates persisted metadata, including a
 * now-stale linked PR, alongside the new branch). If the listing merge lands
 * first, the identity path sees no branch change and never clears, leaving
 * Checks pinned to the previous branch's PR. Applying the identity update
 * first makes the link clear happen no matter which path wins the race.
 *
 * Only entries that still carry branch-scoped review context are routed: when
 * there is nothing to clear the plain merge already applies the new branch,
 * and skipping the rest preserves the stale-refetch protection where an old
 * listing row must not roll back a newer branch identity.
 */
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
