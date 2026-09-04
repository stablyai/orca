import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { isPositiveHostedReviewNumber } from '../../../../../../shared/hosted-review'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import type { findKnownWorktreeById } from '../listing/detected-worktree-meta'
import { trySettingsForWorktreeOwner } from '../listing/worktree-owner-settings'
import {
  getHostedReviewPushTargetLookup,
  resolveGitHubReviewPushTarget
} from './hosted-review-push-target'

type KnownWorktree = ReturnType<typeof findKnownWorktreeById>

/**
 * Push-target consequences of a metadata update: a newly linked review resolves the branch to
 * push to, and an unlinked or replaced review stops steering pushes. Split out of
 * updateWorktreeMeta because it is the one part of that flow that needs an owner lookup and a
 * network round trip before the optimistic apply.
 */
export async function resolveHostedReviewPushTargetUpdate(
  get: WorktreeSliceGet,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  existingWorktree: KnownWorktree,
  normalizedUpdates: Partial<WorktreeMeta>
): Promise<{
  resolvedPushTarget: Awaited<ReturnType<typeof resolveGitHubReviewPushTarget>> | undefined
  shouldClearStaleHostedReviewPushTarget: boolean
}> {
  // Why: manual PR linking supplies only the number; resolve the head branch so Push targets the review branch.
  const linkedPrForPushTarget = isPositiveHostedReviewNumber(normalizedUpdates.linkedPR)
    ? normalizedUpdates.linkedPR
    : null
  // Why: an ambiguous owner must not throw past this update's { ok, error } contract — skip the lookup instead.
  const pushTargetOwnerSettings =
    linkedPrForPushTarget !== null &&
    normalizedUpdates.pushTarget === undefined &&
    existingWorktree &&
    !existingWorktree.pushTarget
      ? trySettingsForWorktreeOwner(get(), worktreeId, executionHostId)
      : null
  const resolvedPushTarget =
    pushTargetOwnerSettings && existingWorktree && linkedPrForPushTarget !== null
      ? await resolveGitHubReviewPushTarget(
          pushTargetOwnerSettings,
          existingWorktree.repoId,
          linkedPrForPushTarget
        )
      : undefined
  const existingHostedReviewPushTargetLookup = existingWorktree
    ? getHostedReviewPushTargetLookup(existingWorktree)
    : null
  const nextHostedReviewPushTargetLookup = existingWorktree
    ? getHostedReviewPushTargetLookup({ ...existingWorktree, ...normalizedUpdates })
    : null
  // Why: a pushTarget derived from a linked review must not keep steering pushes after it's unlinked or replaced.
  const shouldClearStaleHostedReviewPushTarget =
    Boolean(existingWorktree?.pushTarget) &&
    normalizedUpdates.pushTarget === undefined &&
    resolvedPushTarget === undefined &&
    existingHostedReviewPushTargetLookup !== null &&
    existingHostedReviewPushTargetLookup.key !== nextHostedReviewPushTargetLookup?.key
  return { resolvedPushTarget, shouldClearStaleHostedReviewPushTarget }
}
