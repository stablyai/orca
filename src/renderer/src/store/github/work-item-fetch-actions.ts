import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { WorkItemsCacheError } from './cache-model'
import { isGitHubWorkItemsSshRemoteRequiredError } from '../../../../shared/work-items'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import { isGitHubWorkItemsQueryTooLarge } from '../slices/github-work-items-query-bounds'
import { reconcileCatalogRows } from '../slices/repo-identity-reconcile'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import { workItemsCacheKey, workItemsInflightRequestKey } from './cache-identity'
import { isFresh, withBoundedCacheEntry, WORK_ITEMS_CACHE_TTL } from './cache-policy'
import {
  acquireProviderRequestSlot as acquireWorkItemSlot,
  inflightWorkItemsRequests,
  releaseProviderRequestSlot as releaseWorkItemSlot
} from './request-coordination'
import { findRepoForGitHubOwner } from './repository-routing'
import {
  getGitHubWorkItemRequestContext,
  getGitHubWorkItemSourceCacheScope,
  getGitHubWorkItemSourceHostId,
  getGitHubWorkItemSourceSettings,
  getWorkItemsCacheKeyForOwner,
  listGitHubWorkItemsForRepo
} from './work-item-routing'

export const createWorkItemFetchActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<
  GitHubSlice,
  | 'getCachedWorkItems'
  | 'getWorkItemsSourcesAndError'
  | 'getWorkItemsAnySourcesForRepo'
  | 'fetchWorkItems'
> => ({
  getCachedWorkItems: (repoId, limit, query, repoPath, sourceContext) => {
    if (isGitHubWorkItemsQueryTooLarge(query)) {
      return null
    }
    const state = get()
    const key =
      sourceContext?.provider === 'github'
        ? workItemsCacheKey(repoId, limit, query, getTaskSourceCacheScope(sourceContext))
        : getWorkItemsCacheKeyForOwner(state, repoId, limit, query, repoPath)
    return get().workItemsCache[key]?.data ?? null
  },

  getWorkItemsSourcesAndError: (repoId, limit, query, repoPath) => {
    if (isGitHubWorkItemsQueryTooLarge(query)) {
      return { sources: null, error: null }
    }
    const key = getWorkItemsCacheKeyForOwner(get(), repoId, limit, query, repoPath)
    const entry = get().workItemsCache[key]
    return {
      sources: entry?.sources ?? null,
      error: entry?.error ?? null
    }
  },

  getWorkItemsAnySourcesForRepo: (repoId, limit, repoPath) => {
    const cache = get().workItemsCache
    const primaryKey = getWorkItemsCacheKeyForOwner(get(), repoId, limit, '', repoPath)
    const primary = cache[primaryKey]?.sources
    if (primary) {
      return primary
    }
    const prefix = primaryKey
    for (const [key, entry] of Object.entries(cache)) {
      if (key.startsWith(prefix) && entry.sources) {
        return entry.sources
      }
    }
    return null
  },

  fetchWorkItems: async (
    repoId,
    repoPath,
    limit,
    query,
    options
  ): Promise<readonly GitHubWorkItem[]> => {
    if (isGitHubWorkItemsQueryTooLarge(query)) {
      return []
    }
    const requestState = get()
    const repo = findRepoForGitHubOwner(requestState, repoId, repoPath)
    const requestSettings = getGitHubWorkItemSourceSettings(
      requestState.settings,
      repo,
      options?.sourceContext
    )
    const ownerHostId = getGitHubWorkItemSourceHostId(requestState, repo, options?.sourceContext)
    const cacheScope = getGitHubWorkItemSourceCacheScope(requestState, repo, options?.sourceContext)
    const key = workItemsCacheKey(repoId, limit, query, cacheScope)
    const cached = get().workItemsCache[key]
    if (!options?.force && isFresh(cached, WORK_ITEMS_CACHE_TTL)) {
      return cached.data ?? []
    }

    const requestInvalidationNonce = requestState.workItemsInvalidationNonce
    const requestContext = getGitHubWorkItemRequestContext(
      requestState,
      requestSettings,
      repoId,
      repoPath,
      options?.sourceContext
    )
    const inflightKey = workItemsInflightRequestKey(key, requestContext.target)
    const existing = inflightWorkItemsRequests.get(inflightKey)
    if (existing) {
      // Why: a forcing/noCache caller must not dedupe to a weaker in-flight fetch (noCache is stricter — it must bypass gh api's cache too).
      if (
        (options?.force && !existing.force) ||
        (options?.noCache && !existing.noCache) ||
        (options?.requireComplete && !existing.requireComplete)
      ) {
        await existing.promise.catch(() => {})
      } else {
        return existing.promise
      }
    }

    const request = (async () => {
      await acquireWorkItemSlot()
      try {
        const envelope = await listGitHubWorkItemsForRepo(requestContext, {
          limit,
          query: query || undefined,
          ...(options?.noCache ? { noCache: true } : {})
        })
        // Why: stamp repoId at the fetch boundary so downstream consumers can rely on it — main doesn't know Orca's Repo.id.
        const items: GitHubWorkItem[] = envelope.items.map((item) => ({ ...item, repoId }))
        if (options?.requireComplete && (envelope.errors?.issues || envelope.errors?.prs)) {
          throw new Error('GitHub work-item fetch returned a partial result.')
        }
        // Why: only surface issues-side errors here; PR-side failures predate the issue-source split (#1076) and are out of scope for this banner (design doc §2).
        const issuesError = envelope.errors?.issues
        // Why: errors.issues without sources.issues has no slug for the banner, so it's dropped from the cache; log it so this rare case is visible in devtools.
        if (issuesError && !envelope.sources.issues) {
          console.warn(
            '[workItems] dropping issues-side error with no resolved source:',
            issuesError
          )
        }
        const errorForCache: WorkItemsCacheError | undefined =
          issuesError && envelope.sources.issues
            ? { ...issuesError, source: envelope.sources.issues }
            : undefined
        const currentRepo = findRepoForGitHubOwner(get(), repoId, repoPath)
        const currentHostId = getGitHubWorkItemSourceHostId(
          get(),
          currentRepo,
          options?.sourceContext
        )
        // Why: repo ownership changed, so this response belongs to an older execution-host bucket (host focus changes alone are fine).
        if ((currentHostId ?? null) !== (ownerHostId ?? null)) {
          return items
        }
        // Why: the old promise can still settle after the in-flight clear; don't let pre-flip source data repopulate the cache once the invalidation nonce changed.
        if (get().workItemsInvalidationNonce !== requestInvalidationNonce) {
          return items
        }
        // Why: TaskPage useShallow-selects cache entry refs. A new { ...entry, fetchedAt }
        // still remaps every visible row. IPC structuredClone rebuilds nested records, so
        // data === previous.data never holds — reconcile structurally, then either mutate
        // fetchedAt in place or write one entry that keeps unchanged row/meta refs.
        set((s) => {
          const previousEntry = s.workItemsCache[key]
          const previousData = previousEntry?.data ?? []
          const reconciled = reconcileCatalogRows(
            previousData,
            items,
            (row) => `${row.repoId}\0${row.id}`
          )
          const nextFellBack = envelope.issueSourceFellBack ? true : undefined
          const sourcesUnchanged = structuralValuesEqual(previousEntry?.sources, envelope.sources)
          const errorUnchanged = structuralValuesEqual(previousEntry?.error, errorForCache)
          const fellBackUnchanged = previousEntry?.issueSourceFellBack === nextFellBack
          if (
            previousEntry &&
            reconciled === previousData &&
            sourcesUnchanged &&
            errorUnchanged &&
            fellBackUnchanged
          ) {
            previousEntry.fetchedAt = Date.now()
            return {}
          }
          const previousSources = previousEntry?.sources
          const previousError = previousEntry?.error
          return {
            workItemsCache: withBoundedCacheEntry(s.workItemsCache, key, {
              // Why: `reconciled` already is `previousEntry.data` when nothing changed —
              // reconcileCatalogRows returns the previous array on a structural match.
              data: reconciled,
              fetchedAt: Date.now(),
              sources:
                sourcesUnchanged && previousSources !== undefined
                  ? previousSources
                  : envelope.sources,
              ...(errorForCache
                ? {
                    error:
                      errorUnchanged && previousError !== undefined ? previousError : errorForCache
                  }
                : {}),
              ...(nextFellBack ? { issueSourceFellBack: true } : {})
            })
          }
        })
        return items
      } catch (err) {
        // Why: rethrow but keep the stale cache entry so the UI still renders while the user retries.
        if (!isGitHubWorkItemsSshRemoteRequiredError(err)) {
          console.error('Failed to fetch GitHub work items:', err)
        }
        throw err
      } finally {
        releaseWorkItemSlot()
        inflightWorkItemsRequests.delete(inflightKey)
      }
    })()

    inflightWorkItemsRequests.set(inflightKey, {
      promise: request,
      force: Boolean(options?.force),
      noCache: Boolean(options?.noCache),
      requireComplete: Boolean(options?.requireComplete)
    })
    return request
  }
})
