import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { PRComment } from '../../../../shared/github/comment-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { prCommentsCacheSuffix, sourceScopedRepoCacheKey } from './cache-identity'
import { isFresh, withBoundedCacheEntry } from './cache-policy'
import {
  inflightCommentsRequests,
  nextProviderRequestId,
  ownsInflightRequest
} from './request-coordination'
import { mergePRCommentIntoList } from './pr-comment-cache'
import {
  getGitHubRepoSourceSettings,
  getGitHubSourceTarget,
  getGitHubWorkItemRequestContext
} from './work-item-routing'

export const createCommentFetchActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'fetchPRComments'> => ({
  fetchPRComments: async (repoPath, prNumber, options): Promise<PRComment[]> => {
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
    const cached = get().commentsCache[cacheKey]
    const force = Boolean(options?.force) || options?.userRefresh === true
    if (!force && isFresh(cached)) {
      return cached.data ?? []
    }

    const inflightRequest = inflightCommentsRequests.get(cacheKey)
    // An explicit refresh replaces a read begun before it instead of joining it.
    if (inflightRequest && !options?.userRefresh) {
      return inflightRequest.promise
    }

    const requestId = nextProviderRequestId()
    const requestStartedAt = Date.now()
    // Carry the replaced read's local posts: its reply will no longer publish them.
    const postedComments: PRComment[] = [...(inflightRequest?.postedComments ?? [])]
    let reply: Promise<PRComment[]> | undefined
    const request = (async () => {
      try {
        const requestContext = getGitHubWorkItemRequestContext(
          get(),
          getGitHubSourceTarget(get(), repo, options?.sourceContext),
          repoId ?? repoPath,
          repoPath,
          options?.sourceContext
        )
        reply =
          requestContext.target.kind === 'environment'
            ? callRuntimeRpc<PRComment[]>(
                { kind: 'environment', environmentId: requestContext.target.environmentId },
                'github.prComments',
                {
                  repo: requestContext.target.runtimeRepoId,
                  prNumber,
                  prRepo: options?.prRepo ?? null,
                  noCache: force
                },
                { timeoutMs: 30_000 }
              )
            : window.api.gh.prComments({
                repoPath,
                repoId,
                prNumber,
                prRepo: options?.prRepo ?? null,
                noCache: force,
                sourceContext: options?.sourceContext
              })
        // If this read fails, the read it replaced still lands its answer, which is newer than the cache.
        let comments = await reply.catch(async (err: unknown) => {
          if (!inflightRequest?.reply) {
            throw err
          }
          return inflightRequest.reply.catch(() => {
            throw err
          })
        })
        if (!ownsInflightRequest(inflightCommentsRequests, cacheKey, requestId)) {
          // Its callers show the owner's answer, so a late superseded reply cannot repaint older comments.
          await inflightCommentsRequests.get(cacheKey)?.promise
          const latest = get().commentsCache[cacheKey]
          return latest?.data && latest.fetchedAt >= requestStartedAt ? latest.data : comments
        }
        if (postedComments.length > 0) {
          const currentById = new Map(
            (get().commentsCache[cacheKey]?.data ?? []).map((comment) => [comment.id, comment])
          )
          for (const posted of postedComments) {
            comments = mergePRCommentIntoList(comments, currentById.get(posted.id) ?? posted)
          }
        }
        set((s) => ({
          commentsCache: withBoundedCacheEntry(s.commentsCache, cacheKey, {
            data: comments,
            fetchedAt: Date.now()
          })
        }))
        return comments
      } catch (err) {
        console.error('Failed to fetch PR comments:', err)
        return get().commentsCache[cacheKey]?.data ?? []
      } finally {
        if (ownsInflightRequest(inflightCommentsRequests, cacheKey, requestId)) {
          inflightCommentsRequests.delete(cacheKey)
        }
      }
    })()

    inflightCommentsRequests.set(cacheKey, { promise: request, reply, requestId, postedComments })
    return request
  }
})
