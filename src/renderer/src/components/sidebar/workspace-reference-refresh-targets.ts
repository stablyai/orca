import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { getVisibleHostedReviewWorkspaces } from '@/store/github/visible-hosted-review-refresh-targets'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import type { VisibleHostedReviewRefreshTarget } from '@/store/github/visible-hosted-review-refresh-scheduler'
import { reviewRefreshIntervalMs } from '../../../../shared/review-refresh-policy'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import {
  getWorkspaceReferenceRequest,
  getWorkspaceReferenceRuntimeVersion,
  matchWorkspaceReferenceReview
} from './workspace-reference-details'
import { canReadWorkspaceReferenceReview } from './workspace-reference-review-source'
import { readWorkspaceReferenceDetails } from './workspace-reference-detail-read'
import { selectIsSleepingWorktree } from './use-worktree-sleep-state'

export function getWorkspaceReferenceRefreshTargets(
  state: AppState,
  options?: { selectedOnly?: boolean }
): VisibleHostedReviewRefreshTarget[] {
  const targets = new Map<string, VisibleHostedReviewRefreshTarget>()
  for (const { worktree, repo, candidate, selected } of getVisibleHostedReviewWorkspaces(
    state,
    options
  )) {
    if (selectIsSleepingWorktree(state, worktree.id)) {
      continue
    }
    const branchKey = getHostedReviewCacheKey(
      repo.path,
      candidate.branch,
      state.settings,
      repo.id,
      repo.connectionId,
      repo.executionHostId,
      true
    )
    const knownProvider =
      state.hostedReviewCache[branchKey]?.data?.provider ??
      (state.prCache[candidate.cacheKey]?.data ? 'github' : undefined)
    const runtimeVersion = getWorkspaceReferenceRuntimeVersion(worktree, repo)
    for (const item of getWorkspaceAttachments(worktree)) {
      if (item.type === 'issue') {
        continue
      }
      const request = {
        ...getWorkspaceReferenceRequest(item, worktree, repo, runtimeVersion),
        knownProvider
      }
      if (!canReadWorkspaceReferenceReview(request, knownProvider)) {
        continue
      }
      const key = request.key
      if (targets.get(key)?.selected) {
        continue
      }
      const entry = state.hostedReviewCache[key]
      const review = matchWorkspaceReferenceReview(item, entry?.data) ? entry?.data : null
      targets.set(key, {
        key,
        revision: key,
        selected,
        fetchedAt: entry?.fetchedAt ?? null,
        intervalMs: reviewRefreshIntervalMs({
          state: review?.state,
          checksStatus: review?.status,
          hasReview: review ? true : null,
          selected
        }),
        refresh: (_force, signal) =>
          withTimeout(
            readWorkspaceReferenceDetails(
              { ...request, admissionTier: selected ? 'interactive' : 'background' },
              signal
            ).then(
              (data) =>
                !signal?.aborted &&
                data !== null &&
                !useAppStore.getState().hostedReviewCache[key]?.stale
            ),
            30_000,
            false
          )
      })
    }
  }
  return [...targets.values()]
}
