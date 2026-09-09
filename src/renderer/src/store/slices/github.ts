import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice as GitHubSliceContract } from '../github/slice-types'
import {
  ACTIVE_PR_REFRESH_STATUSES,
  getEffectiveGitHubPRRefreshState,
  isExpiredActivePRRefreshState
} from '../github/pr-refresh-state'
import { evictStaleEntries } from '../github/cache-policy'
import { createProjectActions } from '../github/project-actions'
import { createProjectRowActions } from '../github/project-row-actions'
import { createWorkItemFetchActions } from '../github/work-item-fetch-actions'
import { createWorkItemAggregateActions } from '../github/work-item-aggregate-actions'
import { createWorkItemMutationActions } from '../github/work-item-mutation-actions'
import { createPullRequestActions } from '../github/pull-request-actions'
import { createIssueActions } from '../github/issue-actions'
import { createCheckActions } from '../github/check-actions'
import { createCommentFetchActions } from '../github/comment-fetch-actions'
import { createCommentMutationActions } from '../github/comment-mutation-actions'
import { createConversationCommentActions } from '../github/conversation-comment-actions'
import { createReviewThreadActions } from '../github/review-thread-actions'
import { createStaleWorktreeRefreshActions } from '../github/stale-worktree-refresh-actions'
import { createRefreshRoutingActions } from '../github/refresh-routing-actions'
import { createRefreshEventActions } from '../github/refresh-event-actions'
import { createRefreshSweepActions } from '../github/refresh-sweep-actions'
export type GitHubSlice = GitHubSliceContract

export const createGitHubSlice: StateCreator<AppState, [], [], GitHubSlice> = (set, get) => ({
  prCache: {},
  issueCache: {},
  checksCache: {},
  commentsCache: {},
  prRefreshSequences: {},
  prRefreshStates: {},
  prVisibleRefreshGeneration: 0,
  workItemsCache: {},
  workItemsInvalidationNonce: 0,
  projectViewCache: {},

  getEffectiveGitHubPRRefreshState: (cacheKey, now) =>
    getEffectiveGitHubPRRefreshState(get().prRefreshStates, cacheKey, now),

  expireGitHubPRRefreshState: (cacheKey, token, now = Date.now()) => {
    const currentState = get()
    const currentRefreshState = currentState.prRefreshStates[cacheKey]
    if (
      !currentRefreshState ||
      !ACTIVE_PR_REFRESH_STATUSES.has(currentRefreshState.status) ||
      !isExpiredActivePRRefreshState(currentRefreshState, now) ||
      (currentState.prRefreshSequences[cacheKey] ?? 0) !== token.sequence ||
      currentRefreshState.status !== token.status ||
      currentRefreshState.updatedAt !== token.updatedAt
    ) {
      return
    }
    set((s) => {
      const state = s.prRefreshStates[cacheKey]
      if (
        !state ||
        !ACTIVE_PR_REFRESH_STATUSES.has(state.status) ||
        !isExpiredActivePRRefreshState(state, now) ||
        (s.prRefreshSequences[cacheKey] ?? 0) !== token.sequence ||
        state.status !== token.status ||
        state.updatedAt !== token.updatedAt
      ) {
        return s
      }
      const nextStates = { ...s.prRefreshStates }
      delete nextStates[cacheKey]
      return { prRefreshStates: nextStates }
    })
  },

  ...createProjectActions(set, get),
  ...createProjectRowActions(set, get),
  ...createWorkItemFetchActions(set, get),
  ...createWorkItemAggregateActions(get),
  ...createPullRequestActions(set, get),
  ...createIssueActions(set, get),
  ...createCheckActions(set, get),
  ...createCommentFetchActions(set, get),
  ...createCommentMutationActions(set, get),
  ...createConversationCommentActions(set, get),
  ...createReviewThreadActions(set, get),
  ...createStaleWorktreeRefreshActions(get),
  ...createRefreshRoutingActions(set, get),
  ...createRefreshEventActions(set, get),
  ...createRefreshSweepActions(set, get),
  ...createWorkItemMutationActions(set, get),

  initGitHubCache: async () => {
    try {
      const persisted = await window.api.cache.getGitHub()
      if (persisted) {
        set({
          prCache: evictStaleEntries(persisted.pr || {}),
          issueCache: evictStaleEntries(persisted.issue || {})
        })
      }
    } catch (err) {
      console.error('Failed to load GitHub cache from disk:', err)
    }
  }
})
