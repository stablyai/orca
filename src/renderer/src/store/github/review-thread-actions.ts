import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import {
  markPRCommentThreadResolved,
  restorePRCommentThreadSnapshot
} from '@/lib/pr-comment-thread-resolution'
import { prCommentsCacheSuffix, sourceScopedRepoCacheKey } from './cache-identity'
import {
  getGitHubRepoSourceSettings,
  getGitHubSourceTarget,
  getGitHubWorkItemRequestContext
} from './work-item-routing'
import {
  reviewThreadInFlightKey,
  withReviewThreadInFlight
} from './review-thread-resolution-in-flight'

export const createReviewThreadActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'resolveReviewThread'> => ({
  resolveReviewThread: async (repoPath, prNumber, threadId, resolve, options) => {
    const repo = get().repos?.find((candidate) =>
      options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
    )
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = getGitHubRepoSourceSettings(get(), repo, options?.sourceContext)
    const cacheKey = sourceScopedRepoCacheKey(
      repoPath,
      repoId,
      prCommentsCacheSuffix(prNumber, options?.prRepo),
      requestSettings,
      repo?.connectionId,
      repo?.executionHostId,
      options?.sourceContext,
      repo !== undefined
    )

    const inFlightKey = reviewThreadInFlightKey(cacheKey, threadId)
    // Why: overlapping opposite requests can settle in either order; true keeps callers from toasting or rolling back.
    if (get().reviewThreadResolutionsInFlight[inFlightKey] !== undefined) {
      return true
    }
    set((s) => withReviewThreadInFlight(s, inFlightKey, threadId))
    try {
      const previousThreadComments =
        get().commentsCache[cacheKey]?.data?.filter((comment) => comment.threadId === threadId) ??
        []
      if (previousThreadComments.length > 0) {
        set((s) => {
          const entry = s.commentsCache[cacheKey]
          if (!entry?.data) {
            return s
          }
          return {
            commentsCache: {
              ...s.commentsCache,
              [cacheKey]: {
                ...entry,
                data: markPRCommentThreadResolved(entry.data, threadId, resolve)
              }
            }
          }
        })
      }

      const requestContext = getGitHubWorkItemRequestContext(
        get(),
        getGitHubSourceTarget(get(), repo, options?.sourceContext),
        repoId ?? repoPath,
        repoPath,
        options?.sourceContext
      )
      let ok = false
      try {
        ok =
          requestContext.target.kind === 'environment'
            ? await callRuntimeRpc<boolean>(
                { kind: 'environment', environmentId: requestContext.target.environmentId },
                'github.resolveReviewThread',
                {
                  repo: requestContext.target.runtimeRepoId,
                  threadId,
                  resolve,
                  prRepo: options?.prRepo ?? null
                },
                { timeoutMs: 30_000 }
              )
            : await window.api.gh.resolveReviewThread({
                repoPath,
                repoId,
                threadId,
                resolve,
                prRepo: options?.prRepo ?? null,
                sourceContext: options?.sourceContext
              })
      } catch (err) {
        console.error('Failed to update review thread:', err)
        ok = false
      }
      if (!ok && previousThreadComments.length > 0) {
        set((s) => {
          const entry = s.commentsCache[cacheKey]
          if (!entry?.data) {
            return s
          }
          return {
            commentsCache: {
              ...s.commentsCache,
              [cacheKey]: {
                ...entry,
                data: restorePRCommentThreadSnapshot(entry.data, previousThreadComments)
              }
            }
          }
        })
      }
      return ok
    } finally {
      set((s) => withReviewThreadInFlight(s, inFlightKey, null))
    }
  }
})
