import { githubTaskBinding } from '@/lib/github-task-observation'
import { getWorkItemPageErrorTypes } from '../../../../../shared/github/work-item-page-errors'
import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { GitHubSlice } from '../github-slice-contract'
import type { ClassifiedError } from '../../../../../shared/classified-error'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import {
  isGitHubWorkItemsSshRemoteRequiredError,
  sortWorkItemsByNumber,
  PER_REPO_FETCH_LIMIT
} from '../../../../../shared/work-items'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import { isGitHubWorkItemsQueryTooLarge } from '../../../../../shared/github/work-items-query-bounds'
import { workItemsCacheKey, workItemsInflightRequestKey } from '../cache/cache-identity'
import { isFresh, WORK_ITEMS_CACHE_TTL } from '../cache/cache-policy'
import {
  acquireProviderRequestSlot as acquireWorkItemSlot,
  inflightWorkItemsRequests,
  releaseProviderRequestSlot as releaseWorkItemSlot
} from '../requests/request-coordination'
import {
  getGitHubWorkItemRequestContext,
  findGitHubWorkItemRepo,
  getWorkItemsCacheKeyForOwner,
  isGitHubUnavailableWorkItemsError,
  listGitHubWorkItemsForRepo,
  getGitHubSourceTarget,
  getGitHubWorkItemRowHostId
} from './work-item-routing'

export const createWorkItemAggregateActions = (
  get: Parameters<StateCreator<AppState>>[1]
): Pick<
  GitHubSlice,
  'fetchWorkItemsAcrossRepos' | 'fetchWorkItemsNextPage' | 'prefetchWorkItems'
> => ({
  fetchWorkItemsAcrossRepos: async (repos, perRepoLimit, displayLimit, query, options) => {
    if (isGitHubWorkItemsQueryTooLarge(query)) {
      return { items: [], failedCount: 0, githubUnavailable: false }
    }
    const state = get()
    let failedCount = 0
    let requestFailureCount = 0
    let unavailableFailureCount = 0
    let skippedSourceCount = 0
    const perProjectResults = await Promise.all(
      repos.map(async (r) => {
        try {
          return await state.fetchWorkItems(r.repoId, r.path, perRepoLimit, query, {
            ...options,
            sourceContext: r.sourceContext ?? options?.sourceContext
          })
        } catch (err) {
          // Why: fall back to any cache entry (stale or not) before declaring this repo failed; only count as failed when it has nothing to contribute.
          // Why: use perRepoLimit (not displayLimit) so the cache key matches what fetchWorkItems wrote.
          if (isGitHubWorkItemsSshRemoteRequiredError(err)) {
            if (options?.requireComplete) {
              requestFailureCount += 1
              failedCount += 1
            }
            skippedSourceCount += 1
            return [] as GitHubWorkItem[]
          }
          requestFailureCount += 1
          if (isGitHubUnavailableWorkItemsError(err)) {
            unavailableFailureCount += 1
          }
          const key =
            r.sourceContext?.provider === 'github'
              ? workItemsCacheKey(
                  r.repoId,
                  perRepoLimit,
                  query,
                  getTaskSourceCacheScope(r.sourceContext),
                  (() => {
                    const repo = findGitHubWorkItemRepo(get(), r.repoId, r.path, r.sourceContext)
                    return repo && githubTaskBinding(repo)
                  })()
                )
              : getWorkItemsCacheKeyForOwner(get(), r.repoId, perRepoLimit, query, r.path)
          const cached = get().workItemsCache[key]?.data
          if (cached && options?.allowStaleFallback !== false) {
            console.warn(`[workItems] ${r.repoId} failed, serving cached:`, err)
            return cached
          }
          console.warn(`[workItems] ${r.repoId} failed:`, err)
          failedCount += 1
          return [] as GitHubWorkItem[]
        }
      })
    )
    if (perProjectResults.some((result) => result === undefined)) {
      return undefined
    }
    const merged = sortWorkItemsByNumber(perProjectResults.flatMap((result) => result ?? [])).slice(
      0,
      displayLimit
    )
    // Why: only claim global unavailability when every eligible source failed for a reachability reason; skipped SSH repos aren't GitHub sources here.
    const githubUnavailable =
      requestFailureCount > 0 &&
      requestFailureCount === repos.length - skippedSourceCount &&
      unavailableFailureCount === requestFailureCount
    return {
      items: merged,
      failedCount,
      githubUnavailable,
      ...(requestFailureCount > 0 ? { requestFailureCount } : {})
    }
  },

  fetchWorkItemsNextPage: async (repos, perRepoLimit, displayLimit, query, page, options) => {
    if (isGitHubWorkItemsQueryTooLarge(query)) {
      return { items: [], failedCount: 0, errorTypes: [] }
    }
    let failedCount = 0
    const errorTypes: ClassifiedError['type'][] = []
    const perProjectResults = await Promise.all(
      repos.map(async (r) => {
        const requestState = get()
        const repo = findGitHubWorkItemRepo(requestState, r.repoId, r.path, r.sourceContext)
        const requestContext = getGitHubWorkItemRequestContext(
          requestState,
          getGitHubSourceTarget(requestState, repo, r.sourceContext),
          r.repoId,
          r.path,
          r.sourceContext
        )
        const attempt = requestState.githubSourceCollections.capture(repo, r.sourceContext)
        await acquireWorkItemSlot()
        try {
          if (!get().githubSourceCollections.current(attempt)) {
            return undefined
          }
          const envelope = await listGitHubWorkItemsForRepo(requestContext, {
            limit: perRepoLimit,
            query: query || undefined,
            page,
            ...(options?.noCache ? { noCache: true } : {}),
            ...(options?.wakeWslDistro ? { wakeWslDistro: true } : {})
          })
          if (!get().githubSourceCollections.accept(attempt, envelope, query, false)) {
            return undefined
          }
          errorTypes.push(...getWorkItemPageErrorTypes(envelope.errors))
          // Page-N errors bypass initial-fetch banners; log them to expose silent truncation (design §6).
          if (envelope.errors?.issues) {
            console.warn(
              `[workItems] next page ${r.repoId} issues-side partial failure:`,
              envelope.errors.issues
            )
          }
          if (envelope.errors?.prs) {
            console.warn(
              `[workItems] next page ${r.repoId} prs-side partial failure:`,
              envelope.errors.prs
            )
          }
          if (options?.requireComplete && (envelope.errors?.issues || envelope.errors?.prs)) {
            failedCount += 1
            return [] as GitHubWorkItem[]
          }
          const repoHostId = getGitHubWorkItemRowHostId(
            requestState,
            r.repoId,
            r.path,
            r.sourceContext
          )
          const items = envelope.items.map((item): GitHubWorkItem => ({
            ...item,
            repoId: r.repoId,
            ...(repoHostId ? { repoHostId } : {})
          }))
          return get().githubTaskCache.acceptSearch(items, attempt.binding)
        } catch (err) {
          if (!get().githubSourceCollections.current(attempt)) {
            return undefined
          }
          if (isGitHubWorkItemsSshRemoteRequiredError(err)) {
            if (options?.requireComplete) {
              failedCount += 1
            }
            return [] as GitHubWorkItem[]
          }
          console.warn(`[workItems] next page ${r.repoId} failed:`, err)
          failedCount += 1
          return [] as GitHubWorkItem[]
        } finally {
          releaseWorkItemSlot()
        }
      })
    )
    if (perProjectResults.some((result) => result === undefined)) {
      return undefined
    }
    const merged = sortWorkItemsByNumber(perProjectResults.flatMap((result) => result ?? [])).slice(
      0,
      displayLimit
    )
    return { items: merged, failedCount, errorTypes }
  },

  prefetchWorkItems: (repoId, repoPath, limit = PER_REPO_FETCH_LIMIT, query = '', options) => {
    if (isGitHubWorkItemsQueryTooLarge(query)) {
      return
    }
    const requestState = get()
    const repo = findGitHubWorkItemRepo(requestState, repoId, repoPath, options?.sourceContext)
    const key =
      options?.sourceContext?.provider === 'github'
        ? workItemsCacheKey(
            repoId,
            limit,
            query,
            getTaskSourceCacheScope(options.sourceContext),
            repo && githubTaskBinding(repo)
          )
        : getWorkItemsCacheKeyForOwner(requestState, repoId, limit, query, repoPath)
    const cached = get().workItemsCache[key]
    const requestContext = getGitHubWorkItemRequestContext(
      requestState,
      getGitHubSourceTarget(requestState, repo, options?.sourceContext),
      repoId,
      repoPath,
      options?.sourceContext
    )
    const inflightKey = workItemsInflightRequestKey(key, requestContext.target)
    if (isFresh(cached, WORK_ITEMS_CACHE_TTL) || inflightWorkItemsRequests.has(inflightKey)) {
      return
    }
    void get()
      .fetchWorkItems(repoId, repoPath, limit, query, { sourceContext: options?.sourceContext })
      .catch(() => {})
  }
})
