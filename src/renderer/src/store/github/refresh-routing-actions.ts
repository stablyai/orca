import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-request-refresh-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { bypassesGitHubPRRefreshFreshness } from './pr-refresh-state'
import {
  enqueueLocalGitHubPRRefresh,
  getPRRefreshRuntimeRepoTarget,
  shouldEnqueueLocalPRRefresh
} from './repository-routing'
import { buildPRRefreshCandidate, findWorktreeById } from './worktree-refresh'
import { getVisibleHostedReviewWorkspaces } from './visible-hosted-review-refresh-targets'
import {
  hasNonGitHubReview,
  shouldCoordinateVisibleGitHubReview
} from './visible-hosted-review-refresh-ownership'

export const createRefreshRoutingActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<
  GitHubSlice,
  | 'enqueueGitHubPRRefresh'
  | 'reportVisibleGitHubPRRefreshCandidates'
  | 'bumpGitHubPRVisibleRefreshGeneration'
  | 'setVisibleReviewCardWorktreeIds'
> => ({
  setVisibleReviewCardWorktreeIds: (ids) => {
    set((s) =>
      s.visibleReviewCardWorktreeIds?.length === ids.length &&
      ids.every((id, index) => s.visibleReviewCardWorktreeIds[index] === id)
        ? s
        : { visibleReviewCardWorktreeIds: ids }
    )
  },
  enqueueGitHubPRRefresh: (worktreeId, reason, priority = 0) => {
    const state = get()
    const worktree = findWorktreeById(state, worktreeId)
    const candidate = worktree ? buildPRRefreshCandidate(state, worktree) : null
    if (!candidate) {
      return
    }
    if (worktree && hasNonGitHubReview(state, worktree, candidate)) {
      return
    }
    if (getPRRefreshRuntimeRepoTarget(state, candidate)) {
      void get().fetchPRForBranch(candidate.repoPath, candidate.branch, {
        force: bypassesGitHubPRRefreshFreshness(reason),
        repoId: candidate.repoId,
        repoOwnerExecutionHostId: getRepoExecutionHostId(candidate),
        worktreeId: candidate.worktreeId,
        linkedPRNumber: candidate.linkedPRNumber ?? null,
        fallbackPRNumber: candidate.fallbackPRNumber ?? null,
        fallbackPRSource: candidate.fallbackPRSource ?? null,
        reason
      })
      return
    }
    if (!shouldEnqueueLocalPRRefresh(candidate)) {
      return
    }
    enqueueLocalGitHubPRRefresh({ candidate, reason, priority }, async () => {
      await get().fetchPRForBranch(candidate.repoPath, candidate.branch, {
        force: bypassesGitHubPRRefreshFreshness(reason),
        repoId: candidate.repoId,
        repoOwnerExecutionHostId: getRepoExecutionHostId(candidate),
        worktreeId: candidate.worktreeId,
        linkedPRNumber: candidate.linkedPRNumber ?? null,
        fallbackPRNumber: candidate.fallbackPRNumber ?? null,
        fallbackPRSource: candidate.fallbackPRSource ?? null,
        reason
      })
    })
  },

  reportVisibleGitHubPRRefreshCandidates: async (worktreeIds, generation) => {
    set((s) =>
      s.visibleReviewWorktreeIds?.length === worktreeIds.length &&
      worktreeIds.every((id, index) => s.visibleReviewWorktreeIds[index] === id)
        ? s
        : { visibleReviewWorktreeIds: worktreeIds }
    )
    const state = get()
    const localCandidates: GitHubPRRefreshCandidate[] = []
    for (const { worktree, candidate } of getVisibleHostedReviewWorkspaces(state, {
      worktreeIds
    })) {
      if (
        findWorktreeById(state, worktree.id, getRepoExecutionHostId(candidate)) !== worktree ||
        !shouldCoordinateVisibleGitHubReview(state, worktree, candidate)
      ) {
        continue
      }
      if (getPRRefreshRuntimeRepoTarget(state, candidate)) {
        continue
      }
      if (shouldEnqueueLocalPRRefresh(candidate)) {
        localCandidates.push(candidate)
      }
    }
    const reportVisible = window.api.gh.reportVisiblePRRefreshCandidates
    if (reportVisible) {
      await reportVisible({ candidates: localCandidates, generation }).catch((err) => {
        console.warn('Failed to report visible PR refresh candidates:', err)
      })
    }
  },

  bumpGitHubPRVisibleRefreshGeneration: () => {
    set((s) => ({ prVisibleRefreshGeneration: s.prVisibleRefreshGeneration + 1 }))
  }
})
