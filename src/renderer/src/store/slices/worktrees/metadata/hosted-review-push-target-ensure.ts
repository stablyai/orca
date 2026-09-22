import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import {
  getHostedReviewPushTargetLookup,
  hostedReviewPushTargetLookupsInFlight
} from './hosted-review-push-target'
import { trySettingsForWorktreeOwner } from '../listing/worktree-owner-settings'

export function createEnsureHostedReviewPushTarget(
  _set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['ensureHostedReviewPushTarget'] {
  return async (worktreeId) => {
    const worktree = get().getKnownWorktreeById(worktreeId)
    if (!worktree || worktree.pushTarget) {
      return
    }
    const lookup = getHostedReviewPushTargetLookup(worktree)
    if (!lookup || hostedReviewPushTargetLookupsInFlight.has(lookup.key)) {
      return
    }
    hostedReviewPushTargetLookupsInFlight.add(lookup.key)
    try {
      // Why: an ambiguous owner is a skip, not a crash — this runs as fire-and-forget background restoration.
      const ownerSettings = trySettingsForWorktreeOwner(get(), worktreeId)
      if (!ownerSettings) {
        return
      }
      const resolvedPushTarget = await lookup.resolve(ownerSettings)
      if (!resolvedPushTarget) {
        return
      }
      const current = get().getKnownWorktreeById(worktreeId)
      if (!current || current.pushTarget) {
        return
      }
      const currentLookup = getHostedReviewPushTargetLookup(current)
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
