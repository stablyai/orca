import type { WorktreeMetaBatchUpdate } from '../../worktree-helpers'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import {
  selectWorktreesByRepo,
  selectDetectedWorktreesByRepo
} from '../../../workspace-record-selectors'
import type { Repo } from '../../../../../../shared/repo-types'
import { applyWorktreeUpdates } from '../../worktree-helpers'
import { applyDetectedWorktreeUpdates } from '../listing/detected-worktree-meta'
import { getHostedReviewCacheKey } from '../../hosted-review-cache-identity'
import { getGitHubPRCacheKeyCandidates } from '../../../../../../shared/github/github-cache-key'

type WorktreeMetaStateUpdate = WorktreeMetaBatchUpdate & {
  reviewRepo?: Repo
  reviewBranch?: string
}

export function buildWorktreeMetaStateUpdate(
  s: ReturnType<WorktreeSliceGet>,
  { worktreeId, updates, executionHostId, reviewRepo, reviewBranch }: WorktreeMetaStateUpdate
) {
  const worktreesByRepo = selectWorktreesByRepo(s)
  const detectedWorktreesByRepo = selectDetectedWorktreesByRepo(s)
  const nextWorktrees = applyWorktreeUpdates(worktreesByRepo, worktreeId, updates, executionHostId)
  const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
    detectedWorktreesByRepo,
    worktreeId,
    updates,
    executionHostId
  )
  const cacheKey =
    reviewRepo && reviewBranch
      ? getHostedReviewCacheKey(
          reviewRepo.path,
          reviewBranch,
          s.settings,
          reviewRepo.id,
          reviewRepo.connectionId,
          reviewRepo.executionHostId,
          true
        )
      : null
  const prCacheKeys =
    reviewRepo && reviewBranch ? getGitHubPRCacheKeyCandidates(reviewRepo, reviewBranch) : []
  const prCacheKey = prCacheKeys[0] ?? null
  const hostedReviewCache = s.hostedReviewCache ?? {}
  const prCache = s.prCache ?? {}
  if (
    nextWorktrees === worktreesByRepo &&
    nextDetectedWorktrees === detectedWorktreesByRepo &&
    !cacheKey &&
    !prCacheKey
  ) {
    return s
  }

  const nextHostedReviewCache =
    cacheKey && hostedReviewCache[cacheKey]
      ? (() => {
          const next = { ...hostedReviewCache }
          delete next[cacheKey]
          return next
        })()
      : hostedReviewCache
  const nextPRCache = prCacheKeys.some((key) => prCache[key])
    ? (() => {
        const next = { ...prCache }
        for (const key of prCacheKeys) {
          delete next[key]
        }
        return next
      })()
    : prCache

  return {
    ...(nextWorktrees !== worktreesByRepo
      ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
      : {}),
    ...(nextDetectedWorktrees !== detectedWorktreesByRepo
      ? { detectedWorktreesByRepo: nextDetectedWorktrees }
      : {}),
    ...(nextHostedReviewCache !== hostedReviewCache
      ? { hostedReviewCache: nextHostedReviewCache }
      : {}),
    ...(nextPRCache !== prCache ? { prCache: nextPRCache } : {})
  }
}
