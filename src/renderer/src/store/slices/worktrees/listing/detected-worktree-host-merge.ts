import type { ProjectHostSetup } from '../../../../../../shared/project-types'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { sanitizeHostedReviewLinksForBranchClears } from '../metadata/hosted-review-link-mutation'
import {
  mergeWorktreesForHost,
  withRepoHostOwnership,
  worktreeMatchesHost
} from './worktree-host-ownership'
import type { WorktreeHostMatchOptions } from './worktree-slice-types'

export function mergeDetectedWorktreesForHost(
  current: DetectedWorktreeListResult | undefined,
  refreshed: DetectedWorktreeListResult,
  hostId: ExecutionHostId,
  setup?: ProjectHostSetup,
  options?: WorktreeHostMatchOptions
): DetectedWorktreeListResult {
  // Why stamp first: a twin's review-clear tombstone matches rows by their owner stamp.
  const refreshedForHost = sanitizeHostedReviewLinksForBranchClears(
    refreshed.worktrees.map((worktree) => withRepoHostOwnership(worktree, hostId, setup)),
    current?.worktrees
  )
  // Incomplete scans can update positive identities but cannot delete known content owners.
  let incoming = refreshedForHost
  if (!refreshed.authoritative) {
    const refreshedIds = new Set(refreshedForHost.map((row) => row.id))
    incoming = [
      ...refreshedForHost,
      ...(current?.worktrees ?? []).filter(
        (row) => worktreeMatchesHost(row, hostId, options) && !refreshedIds.has(row.id)
      )
    ]
  }
  const worktrees = mergeWorktreesForHost(current?.worktrees, incoming, hostId, options)
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
