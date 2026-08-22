import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { BeadsIssue, BeadsIssueStatus } from '../../../../shared/beads-types'
import type { BeadsIssueFetchPlan } from '../../../../shared/beads-task-query'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import {
  beadsListIssues,
  beadsUpdateIssue,
  isBeadsTaskSourceUnsupportedError,
  type BeadsListIssuesResult
} from '@/runtime/runtime-beads-client'
import {
  BEADS_CACHE_TTL,
  beadsIssueDetailsCacheKey,
  beadsIssueListCacheKey,
  bumpBeadsReadGeneration,
  currentBeadsReadGeneration,
  dropBeadsScopeEntries,
  evictOldestBeadsEntries,
  MAX_BEADS_LIST_CACHE_ENTRIES,
  requireBeadsRepoId,
  type BeadsIssueDetailsCacheEntry,
  type BeadsListCacheEntry,
  type BeadsListErrorKind
} from './beads-issue-cache'
import {
  clearInflightBeadsDetailsReads,
  createBeadsIssueDetailsActions,
  type BeadsIssueDetailsActions
} from './beads-issue-details'

export {
  beadsIssueDetailsCacheKey,
  beadsIssueListCacheKey,
  type BeadsIssueDetailsCacheEntry,
  type BeadsListCacheEntry,
  type BeadsListErrorKind
}

export const BEADS_ISSUE_FETCH_LIMIT = 200

type InflightBeadsListRequest = {
  promise: Promise<BeadsListIssuesResult>
  generation: number
}

const inflightListRequests = new Map<string, InflightBeadsListRequest>()

function strandInflightBeadsReads(): void {
  bumpBeadsReadGeneration()
  inflightListRequests.clear()
  clearInflightBeadsDetailsReads()
}

export type BeadsSlice = {
  beadsListCache: Record<string, BeadsListCacheEntry>
  beadsIssueDetailsCache: Record<string, BeadsIssueDetailsCacheEntry>
  fetchBeadsIssues: (
    sourceContext: TaskSourceContext,
    plan: BeadsIssueFetchPlan,
    options?: { force?: boolean; limit?: number }
  ) => Promise<BeadsListIssuesResult>
  prefetchBeadsIssues: (sourceContext: TaskSourceContext, plan: BeadsIssueFetchPlan) => void
  invalidateBeadsIssues: (sourceContext?: TaskSourceContext | null) => void
  /** Optimistic status mutation; resolves with the refreshed issue, rolls back and rethrows on failure. */
  updateBeadsIssueStatus: (
    sourceContext: TaskSourceContext,
    id: string,
    status: BeadsIssueStatus
  ) => Promise<BeadsIssue>
} & BeadsIssueDetailsActions

export const createBeadsSlice: StateCreator<AppState, [], [], BeadsSlice> = (set, get) => ({
  beadsListCache: {},
  beadsIssueDetailsCache: {},
  ...createBeadsIssueDetailsActions(set, get),

  fetchBeadsIssues: async (sourceContext, plan, options) => {
    const repoId = requireBeadsRepoId(sourceContext)
    const cacheKey = beadsIssueListCacheKey(sourceContext, plan)
    const cached = get().beadsListCache[cacheKey]
    // Error entries still carry the last-good data, so consecutive failures must not drop it.
    const goodData = cached?.data ?? null
    // Why: an errored entry never satisfies the cache — the refresh must retry.
    const reusable = options?.force || cached?.error !== undefined ? null : goodData
    if (reusable && Date.now() - (cached?.fetchedAt ?? 0) < BEADS_CACHE_TTL) {
      return reusable
    }
    const inflight = inflightListRequests.get(cacheKey)
    if (!options?.force && inflight && inflight.generation === currentBeadsReadGeneration()) {
      // SWR: hand back stale data now; the running refresh will update the cache.
      return reusable ?? inflight.promise
    }
    const generation = currentBeadsReadGeneration()
    let requestEntry: InflightBeadsListRequest
    // Why: the legacy preset rides along so pre-query-filter hosts (which strip
    // statusScope/assignee) still run the closest supported bd view.
    const promise = beadsListIssues(sourceContext, {
      repoId,
      preset: plan.legacyPreset,
      limit: options?.limit ?? BEADS_ISSUE_FETCH_LIMIT,
      statusScope: plan.statusScope,
      ...(plan.assignee !== null ? { assignee: plan.assignee } : {})
    })
      .then((result) => {
        if (
          inflightListRequests.get(cacheKey) === requestEntry &&
          generation === currentBeadsReadGeneration()
        ) {
          set((s) => ({
            beadsListCache: evictOldestBeadsEntries(
              { ...s.beadsListCache, [cacheKey]: { data: result, fetchedAt: Date.now() } },
              MAX_BEADS_LIST_CACHE_ENTRIES
            )
          }))
        }
        return result
      })
      .catch((error: unknown) => {
        const kind: BeadsListErrorKind = isBeadsTaskSourceUnsupportedError(error)
          ? 'missing-task-source-capability'
          : 'load-failed'
        if (kind === 'load-failed') {
          console.warn('[beads] fetchBeadsIssues failed:', error)
        }
        if (
          inflightListRequests.get(cacheKey) === requestEntry &&
          generation === currentBeadsReadGeneration()
        ) {
          set((s) => ({
            beadsListCache: evictOldestBeadsEntries(
              {
                ...s.beadsListCache,
                [cacheKey]: { data: goodData, fetchedAt: Date.now(), error: kind }
              },
              MAX_BEADS_LIST_CACHE_ENTRIES
            )
          }))
        }
        throw error
      })
      .finally(() => {
        if (inflightListRequests.get(cacheKey) === requestEntry) {
          inflightListRequests.delete(cacheKey)
        }
      })
    requestEntry = { promise, generation }
    inflightListRequests.set(cacheKey, requestEntry)
    if (reusable) {
      // Why: stale-immediately — the background refresh surfaces failures via the cache entry, not this caller.
      promise.catch(() => {})
      return reusable
    }
    return promise
  },

  prefetchBeadsIssues: (sourceContext, plan) => {
    get()
      .fetchBeadsIssues(sourceContext, plan)
      .catch(() => {})
  },

  updateBeadsIssueStatus: async (sourceContext, id, status) => {
    const repoId = requireBeadsRepoId(sourceContext)
    const prefix = `${getTaskSourceCacheScope(sourceContext)}::`
    const snapshot: Record<string, BeadsListCacheEntry> = {}
    const patchScopeIssues = (
      cache: Record<string, BeadsListCacheEntry>,
      map: (entry: BeadsListCacheEntry, key: string) => BeadsListCacheEntry
    ): Record<string, BeadsListCacheEntry> => {
      const next = { ...cache }
      for (const [key, entry] of Object.entries(next)) {
        if (key.startsWith(prefix) && entry.data) {
          next[key] = map(entry, key)
        }
      }
      return next
    }
    set((s) => ({
      beadsListCache: patchScopeIssues(s.beadsListCache, (entry, key) => {
        if (!entry.data?.issues.some((issue) => issue.id === id)) {
          return entry
        }
        snapshot[key] = entry
        return {
          ...entry,
          data: {
            ...entry.data,
            issues: entry.data.issues.map((issue) =>
              issue.id === id ? { ...issue, status } : issue
            )
          }
        }
      })
    }))
    try {
      const result = await beadsUpdateIssue(sourceContext, { repoId, id, status })
      const updated = result.issue
      if (!updated) {
        throw new Error('Beads issue update failed: bd is unavailable or not initialized here.')
      }
      // Strand pre-mutation in-flight reads, then let SWR refetch every preset in the scope.
      strandInflightBeadsReads()
      set((s) => ({
        beadsListCache: patchScopeIssues(s.beadsListCache, (entry) => ({
          ...entry,
          fetchedAt: 0,
          data: entry.data && {
            ...entry.data,
            issues: entry.data.issues.map((issue) => (issue.id === updated.id ? updated : issue))
          }
        }))
      }))
      return updated
    } catch (error) {
      set((s) => {
        const beadsListCache = { ...s.beadsListCache }
        for (const [key, entry] of Object.entries(snapshot)) {
          beadsListCache[key] = entry
        }
        return { beadsListCache }
      })
      throw error
    }
  },

  invalidateBeadsIssues: (sourceContext) => {
    strandInflightBeadsReads()
    set((s) => ({
      beadsListCache: dropBeadsScopeEntries(s.beadsListCache, sourceContext),
      beadsIssueDetailsCache: dropBeadsScopeEntries(s.beadsIssueDetailsCache, sourceContext)
    }))
  }
})
