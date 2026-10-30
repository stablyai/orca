import { captureGitHubTaskObservation, observeGitHubWorkItem } from '@/lib/github-task-observation'

import {
  beginGitHubTaskRead,
  acquireProviderRequestSlot as acquireWorkItemSlot,
  inflightWorkItemsRequests,
  releaseProviderRequestSlot as releaseWorkItemSlot
} from './request-coordination'

import { getWorkItemPageErrorTypes } from '../../../../shared/github/work-item-page-errors'
import type { StateCreator } from 'zustand'

import type { AppState } from '../types'

import type { GitHubSlice } from './slice-types'

import type { ClassifiedError } from '../../../../shared/classified-error'

import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

import {
  getWorkItemCountedTotalPages,
  isGitHubWorkItemsSshRemoteRequiredError,
  sortWorkItemsByNumber,
  PER_REPO_FETCH_LIMIT
} from '../../../../shared/work-items'

import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import { isGitHubWorkItemsQueryTooLarge } from '../slices/github-work-items-query-bounds'
import { workItemsCacheKey, workItemsInflightRequestKey } from './cache-identity'

import { isFresh, WORK_ITEMS_CACHE_TTL } from './cache-policy'

import { findRepoForGitHubOwner } from './repository-routing'

import {
  countGitHubWorkItemsForRepo,
  getGitHubWorkItemRequestContext,
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
  | 'fetchWorkItemsAcrossRepos'
  | 'fetchWorkItemsNextPage'
  | 'countWorkItemsAcrossRepos'
  | 'prefetchWorkItems'
> => ({
  fetchWorkItemsAcrossRepos: async (repos, perRepoLimit, displayLimit, query, options) => {
    if (isGitHubWorkItemsQueryTooLarge(query)) {
      return { items: [], failedCount: 0, githubUnavailable: false }
    }
    const read = options?.taskRead ?? beginGitHubTaskRead(repos, undefined, get())
    const state = get()
    let failedCount = 0
    let requestFailureCount = 0
    let unavailableFailureCount = 0
    let skippedSourceCount = 0
    return Promise.all(
      repos.map(async (r) => {
        try {
          return await state.fetchWorkItems(r.repoId, r.path, perRepoLimit, query, {
            ...options,
            taskRead: read,
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
                  getTaskSourceCacheScope(r.sourceContext)
                )
              : getWorkItemsCacheKeyForOwner(get(), r.repoId, perRepoLimit, query, r.path)
          const cached = get().workItemsCache[key]?.data
          if (cached && options?.allowStaleFallback !== false) {
            console.warn(`[workItems] ${r.repoId} failed, serving cached:`, err)
            read.borrow(cached)
            return cached
          }
          console.warn(`[workItems] ${r.repoId} failed:`, err)
          failedCount += 1
          return [] as GitHubWorkItem[]
        }
      })
    )
      .then((perProjectResults) => {
        const merged = read.apply(
          sortWorkItemsByNumber(perProjectResults.flat()).slice(0, displayLimit),
          repos.flatMap(
            (r) =>
              get().getCachedWorkItems(r.repoId, perRepoLimit, query, r.path, r.sourceContext) ?? []
          )
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
      })
      .finally(() => {
        if (!options?.taskRead) {
          read.dispose()
        }
      })
  },

  fetchWorkItemsNextPage: async (repos, perRepoLimit, displayLimit, query, page, options) => {
    if (isGitHubWorkItemsQueryTooLarge(query)) {
      return { items: [], failedCount: 0, errorTypes: [] }
    }
    let failedCount = 0
    const read = options?.taskRead ?? beginGitHubTaskRead(repos, undefined, get())
    const errorTypes: ClassifiedError['type'][] = []
    return Promise.all(
      repos.map(async (r) => {
        const requestState = get()
        const repo = findRepoForGitHubOwner(requestState, r.repoId, r.path)
        const requestContext = getGitHubWorkItemRequestContext(
          requestState,
          getGitHubSourceTarget(requestState, repo, r.sourceContext),
          r.repoId,
          r.path,
          r.sourceContext
        )
        const observation =
          repo && captureGitHubTaskObservation(repo, r.sourceContext, requestContext.target)
        await acquireWorkItemSlot()
        try {
          const envelope = await listGitHubWorkItemsForRepo(requestContext, {
            limit: perRepoLimit,
            query: query || undefined,
            page,
            ...(options?.noCache ? { noCache: true } : {}),
            ...(options?.wakeWslDistro ? { wakeWslDistro: true } : {})
          })
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
          return envelope.items.map((item): GitHubWorkItem =>
            observeGitHubWorkItem(
              {
                ...item,
                repoId: r.repoId,
                ...(repoHostId ? { repoHostId } : {})
              },
              observation,
              true
            )
          )
        } catch (err) {
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
      .then((perProjectResults) => {
        const merged = read.apply(
          sortWorkItemsByNumber(perProjectResults.flat()).slice(0, displayLimit),
          repos.flatMap(
            (r) =>
              get().getCachedWorkItems(r.repoId, perRepoLimit, query, r.path, r.sourceContext) ?? []
          )
        )
        return { items: merged, failedCount, errorTypes }
      })
      .finally(() => {
        if (!options?.taskRead) {
          read.dispose()
        }
      })
  },

  countWorkItemsAcrossRepos: async (repos, query, perRepoLimit, options) => {
    if (isGitHubWorkItemsQueryTooLarge(query)) {
      return { totalCount: 0, totalPages: 0 }
    }
    const counts = await Promise.all(
      repos.map(async (r) => {
        // Share fetch admission cap: a 90-repo count otherwise floods main before rate-limit guard observes the first 403.
        const requestState = get()
        const repo = findRepoForGitHubOwner(requestState, r.repoId, r.path)
        const requestContext = getGitHubWorkItemRequestContext(
          requestState,
          getGitHubSourceTarget(requestState, repo, r.sourceContext),
          r.repoId,
          r.path,
          r.sourceContext
        )
        await acquireWorkItemSlot()
        try {
          return await countGitHubWorkItemsForRepo(requestContext, {
            query: query || undefined,
            ...(options?.wakeWslDistro ? { wakeWslDistro: true } : {})
          })
        } catch {
          return 0
        } finally {
          releaseWorkItemSlot()
        }
      })
    )
    return {
      totalCount: counts.reduce((sum, count) => sum + count, 0),
      totalPages: getWorkItemCountedTotalPages(counts, perRepoLimit)
    }
  },

  prefetchWorkItems: (repoId, repoPath, limit = PER_REPO_FETCH_LIMIT, query = '', options) => {
    if (isGitHubWorkItemsQueryTooLarge(query)) {
      return
    }
    const requestState = get()
    const repo = findRepoForGitHubOwner(requestState, repoId, repoPath)
    const key =
      options?.sourceContext?.provider === 'github'
        ? workItemsCacheKey(repoId, limit, query, getTaskSourceCacheScope(options.sourceContext))
        : getWorkItemsCacheKeyForOwner(requestState, repoId, limit, query, repoPath)
    const cached = get().workItemsCache[key]
    const requestContext = getGitHubWorkItemRequestContext(
      requestState,
      getGitHubSourceTarget(requestState, repo, options?.sourceContext),
      repoId,
      repoPath,
      options?.sourceContext
    )
    const observation =
      repo && captureGitHubTaskObservation(repo, options?.sourceContext, requestContext.target)
    const inflightKey = `${workItemsInflightRequestKey(key, requestContext.target)}::${observation?.key ?? ''}`
    if (
      (observation?.key === cached?.fullFetchObservation?.key &&
        isFresh(cached, WORK_ITEMS_CACHE_TTL)) ||
      inflightWorkItemsRequests.has(inflightKey)
    ) {
      return
    }
    void get()
      .fetchWorkItems(repoId, repoPath, limit, query, { sourceContext: options?.sourceContext })
      .catch(() => {})
  }
})
