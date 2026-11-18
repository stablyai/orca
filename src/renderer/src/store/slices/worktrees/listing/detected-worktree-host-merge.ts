import type { ProjectHostSetup } from '../../../../../../shared/project/project-types'
import type {
  DetectedWorktree,
  DetectedWorktreeListResult
} from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { sanitizeHostedReviewLinksForBranchClears } from '../metadata/hosted-review-link-mutation'
import {
  mergeWorktreesForHost,
  withRepoHostOwnership,
  worktreeMatchesHost
} from './worktree-host-ownership'
import { preserveConcurrentDetectedHeads } from './detected-worktree-head-identity'
import type { WorktreeHostMatchOptions } from './worktree-slice-types'

export function mergeDetectedWorktreesForHost(
  current: DetectedWorktreeListResult | undefined,
  refreshed: DetectedWorktreeListResult,
  hostId: ExecutionHostId,
  listing: {
    setup?: ProjectHostSetup
    // Rows seen when the listing started, so a newer head patch survives an older listing.
    requestStartedDetectedWorktrees?: readonly DetectedWorktree[]
  },
  options?: WorktreeHostMatchOptions
): DetectedWorktreeListResult {
  // Why stamp first: a twin's review-clear tombstone matches rows by their owner stamp.
  const refreshedForHost = sanitizeHostedReviewLinksForBranchClears(
    refreshed.worktrees.map((worktree) => withRepoHostOwnership(worktree, hostId, listing.setup)),
    current?.worktrees
  )
  const worktrees = preserveConcurrentDetectedHeads(
    mergeWorktreesForHost(current?.worktrees, refreshedForHost, hostId, options),
    listing.requestStartedDetectedWorktrees,
    current?.worktrees,
    (worktree) => worktreeMatchesHost(worktree, hostId, options)
  )
  if (
    current &&
    current.repoId === refreshed.repoId &&
    current.authoritative === refreshed.authoritative &&
    current.source === refreshed.source &&
    current.unavailableReason === refreshed.unavailableReason &&
    current.failureKind === refreshed.failureKind &&
    current.wslDistroStopped?.distro === refreshed.wslDistroStopped?.distro &&
    current.wslDistroStopped?.state === refreshed.wslDistroStopped?.state &&
    current.worktrees === worktrees
  ) {
    return current
  }
  return {
    ...refreshed,
    worktrees
  }
}
