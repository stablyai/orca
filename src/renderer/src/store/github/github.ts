import { createGitHubSourceCollections } from './sources/source-collections-sync'
import { createGitHubTaskRecordCache } from './task-records/task-record-cache'
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './github-slice-contract'
import {
  ACTIVE_PR_REFRESH_STATUSES,
  getEffectiveGitHubPRRefreshState,
  isExpiredActivePRRefreshState
} from './refresh/pr-refresh-state'
import { evictStaleEntries } from './cache/cache-policy'
import { deletePRRefreshStartedEntry } from './pull-requests/pr-result-cache'
import { persistGitHubCacheChanges } from './cache/cache-persistence'
import { createProjectActions } from './projects/project-actions'
import { createProjectRowActions } from './projects/project-row-actions'
import { createWorkItemFetchActions } from './work-items/work-item-fetch-actions'
import { createWorkItemCountActions } from './work-items/work-item-count-actions'
import { createWorkItemAggregateActions } from './work-items/work-item-aggregate-actions'
import { createWorkItemMutationActions } from './work-items/work-item-mutation-actions'
import { createPullRequestActions } from './pull-requests/pull-request-actions'
import { createIssueActions } from './issues/issue-actions'
import { createCheckActions } from './checks/check-actions'
import { createCommentFetchActions } from './comments/comment-fetch-actions'
import { createCommentMutationActions } from './comments/comment-mutation-actions'
import { createConversationCommentActions } from './comments/conversation-comment-actions'
import { createReviewThreadActions } from './review-threads/review-thread-actions'
import { createStaleWorktreeRefreshActions } from './refresh/stale-worktree-refresh-actions'
import { createRefreshRoutingActions } from './refresh/refresh-routing-actions'
import { createRefreshEventActions } from './refresh/refresh-event-actions'
import { createRefreshSweepActions } from './refresh/refresh-sweep-actions'

export const createGitHubSlice: StateCreator<AppState, [], [], GitHubSlice> = (
  set,
  get,
  store
) => ({
  githubTaskCache: createGitHubTaskRecordCache(store),
  githubSourceCollections: createGitHubSourceCollections(store),
  prCache: {},
  issueCache: {},
  checksCache: {},
  commentsCache: {},
  reviewThreadResolutionsInFlight: {},
  prRefreshSequences: {},
  prRefreshStates: {},
  prVisibleRefreshGeneration: 0,
  visibleReviewWorktreeIds: [],
  visibleReviewCardWorktreeIds: [],
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
      deletePRRefreshStartedEntry(token.sequence, cacheKey)
      return { prRefreshStates: nextStates }
    })
  },

  ...createProjectActions(set, get),
  ...createProjectRowActions(set, get),
  ...createWorkItemFetchActions(set, get),
  ...createWorkItemAggregateActions(get),
  ...createWorkItemCountActions(get),
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
    let persisted: Awaited<ReturnType<typeof window.api.cache.getGitHub>> | null = null
    try {
      persisted = await window.api.cache.getGitHub()
    } catch (err) {
      console.error('Failed to load GitHub cache from disk:', err)
    }
    // Why after the read: an earlier write would replace main's copy with a partial cache.
    // Before hydrating, so main also drops entries hydration evicts.
    persistGitHubCacheChanges(store)
    if (persisted) {
      set({
        prCache: evictStaleEntries(persisted.pr || {}),
        issueCache: evictStaleEntries(persisted.issue || {})
      })
    }
  }
})
