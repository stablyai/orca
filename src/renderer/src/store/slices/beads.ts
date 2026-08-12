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

const CACHE_TTL = 60_000
const MAX_CACHE_ENTRIES = 100
export const BEADS_ISSUE_FETCH_LIMIT = 200

export type BeadsListErrorKind = 'missing-task-source-capability' | 'load-failed'

export type BeadsListCacheEntry = {
  /** Last good list+status; kept through refresh failures so the list doesn't blank. */
  data: BeadsListIssuesResult | null
  fetchedAt: number
  error?: BeadsListErrorKind
}

/** Cache/subscription key for one repo-scoped beads list; TaskPage selects `beadsListCache[key]`. */
export function beadsIssueListCacheKey(
  sourceContext: TaskSourceContext,
  plan: BeadsIssueFetchPlan
): string {
  return `${getTaskSourceCacheScope(sourceContext)}::${plan.statusScope}:a=${plan.assignee ?? ''}`
}

type InflightBeadsListRequest = {
  promise: Promise<BeadsListIssuesResult>
  generation: number
}

const inflightListRequests = new Map<string, InflightBeadsListRequest>()
// Why: invalidation token — bumping it strands in-flight reads so their late results can't repopulate a cleared cache.
let beadsReadGeneration = 0

function evictStaleBeadsEntries(
  cache: Record<string, BeadsListCacheEntry>
): Record<string, BeadsListCacheEntry> {
  const keys = Object.keys(cache)
  if (keys.length <= MAX_CACHE_ENTRIES) {
    return cache
  }
  const sorted = keys.sort((a, b) => (cache[a]?.fetchedAt ?? 0) - (cache[b]?.fetchedAt ?? 0))
  const pruned: Record<string, BeadsListCacheEntry> = {}
  for (const key of sorted.slice(sorted.length - MAX_CACHE_ENTRIES)) {
    pruned[key] = cache[key]
  }
  return pruned
}

export type BeadsSlice = {
  beadsListCache: Record<string, BeadsListCacheEntry>
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
}

export const createBeadsSlice: StateCreator<AppState, [], [], BeadsSlice> = (set, get) => ({
  beadsListCache: {},

  fetchBeadsIssues: async (sourceContext, plan, options) => {
    const repoId = sourceContext.repoId
    if (!repoId) {
      throw new Error('Beads is repo-backed; the task source context must carry a repoId.')
    }
    const cacheKey = beadsIssueListCacheKey(sourceContext, plan)
    const cached = get().beadsListCache[cacheKey]
    const goodData = cached !== undefined && cached.error === undefined ? cached.data : null
    const reusable = options?.force ? null : goodData
    if (reusable && Date.now() - (cached?.fetchedAt ?? 0) < CACHE_TTL) {
      return reusable
    }
    const inflight = inflightListRequests.get(cacheKey)
    if (!options?.force && inflight && inflight.generation === beadsReadGeneration) {
      // SWR: hand back stale data now; the running refresh will update the cache.
      return reusable ?? inflight.promise
    }
    const generation = beadsReadGeneration
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
          generation === beadsReadGeneration
        ) {
          set((s) => ({
            beadsListCache: evictStaleBeadsEntries({
              ...s.beadsListCache,
              [cacheKey]: { data: result, fetchedAt: Date.now() }
            })
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
          generation === beadsReadGeneration
        ) {
          set((s) => ({
            beadsListCache: evictStaleBeadsEntries({
              ...s.beadsListCache,
              [cacheKey]: { data: goodData, fetchedAt: Date.now(), error: kind }
            })
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
    const repoId = sourceContext.repoId
    if (!repoId) {
      throw new Error('Beads is repo-backed; the task source context must carry a repoId.')
    }
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
      beadsReadGeneration += 1
      inflightListRequests.clear()
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
    beadsReadGeneration += 1
    inflightListRequests.clear()
    if (!sourceContext) {
      set({ beadsListCache: {} })
      return
    }
    const prefix = `${getTaskSourceCacheScope(sourceContext)}::`
    set((s) => {
      const beadsListCache: Record<string, BeadsListCacheEntry> = {}
      for (const [key, entry] of Object.entries(s.beadsListCache)) {
        if (!key.startsWith(prefix)) {
          beadsListCache[key] = entry
        }
      }
      return { beadsListCache }
    })
  }
})
