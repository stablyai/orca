import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import {
  getHostedReviewPushTargetLookup,
  hostedReviewPushTargetLookupsInFlight
} from './hosted-review-push-target'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import { findWorktreeRepo } from '../../../github/linked-pr-repository'

export function createEnsureHostedReviewPushTarget(
  _set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['ensureHostedReviewPushTarget'] {
  return async (worktreeId) => {
    const worktree = get().getKnownWorktreeById(worktreeId)
    if (!worktree || worktree.pushTarget) {
      return
    }
    const repo = findWorktreeRepo(get().repos, worktree)
    const lookup = getHostedReviewPushTargetLookup(worktree, repo)
    if (!lookup || hostedReviewPushTargetLookupsInFlight.has(lookup.key)) {
      return
    }
    hostedReviewPushTargetLookupsInFlight.add(lookup.key)
    try {
      // Why: an ambiguous owner is a skip, not a crash — this runs as fire-and-forget background restoration.
      const ownerTarget = runtimeTargetForWorkspaceOwner(get(), { workspaceId: worktreeId })
      if (!ownerTarget) {
        return
      }
      const resolvedPushTarget = await lookup.resolve(ownerTarget)
      if (!resolvedPushTarget) {
        return
      }
      const current = get().getKnownWorktreeById(worktreeId)
      if (!current || current.pushTarget) {
        return
      }
      // Why: the link may have moved to another repository's PR with the same number meanwhile.
      const currentLookup = getHostedReviewPushTargetLookup(current, repo)
      if (currentLookup?.key !== lookup.key) {
        return
      }
      // Why: restore the review head push target so push/status stay aligned after metadata loss.
      await get().updateWorktreeMeta(worktreeId, { pushTarget: resolvedPushTarget })
    } finally {
      hostedReviewPushTargetLookupsInFlight.delete(lookup.key)
    }
  }
}
