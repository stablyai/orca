import type { ProjectHostSetup } from '../../../../../../shared/project-types'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { sanitizeHostedReviewLinksForBranchClears } from '../metadata/hosted-review-link-mutation'
import { mergeWorktreesForHost, withRepoHostOwnership } from './worktree-host-ownership'
import type { WorktreeHostMatchOptions } from './worktree-slice-types'

export function mergeDetectedWorktreesForHost(
  current: DetectedWorktreeListResult | undefined,
  refreshed: DetectedWorktreeListResult,
  hostId: ExecutionHostId,
  setup?: ProjectHostSetup,
  options?: WorktreeHostMatchOptions
): DetectedWorktreeListResult {
  const refreshedForHost = sanitizeHostedReviewLinksForBranchClears(
    refreshed.worktrees,
    current?.worktrees
  ).map((worktree) => withRepoHostOwnership(worktree, hostId, setup))
  const worktrees = mergeWorktreesForHost(current?.worktrees, refreshedForHost, hostId, options)
  if (
    current &&
    current.repoId === refreshed.repoId &&
    current.authoritative === refreshed.authoritative &&
    current.source === refreshed.source &&
    current.worktrees === worktrees
  ) {
    return current
  }
  return {
    ...refreshed,
    worktrees
  }
}
