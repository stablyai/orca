/* eslint-disable max-lines -- Why: the GitHub slice co-locates all cache + fetch logic for
PR, issue, checks, and comments data so the dedup and invalidation patterns stay consistent. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  PRInfo,
  IssueInfo,
  PRCheckDetail,
  PRComment,
  Worktree,
  GitHubWorkItem
} from '../../../../shared/types'
import { sortWorkItemsByUpdatedAt } from '../../../../shared/work-items'
import { syncPRChecksStatus } from './github-checks'

export type CacheEntry<T> = {
  data: T | null
  fetchedAt: number
}

type FetchOptions = {
  force?: boolean
}

const CACHE_TTL = 300_000 // 5 minutes (stale data shown instantly, then refreshed)
const CHECKS_CACHE_TTL = 60_000 // 1 minute — checks change more frequently
// Why: the NewWorkspace page's work-item list is a browse surface, not a
// source of truth, so 60s staleness is fine — stale data renders instantly
// while a background refresh keeps it current.
const WORK_ITEMS_CACHE_TTL = 60_000

const inflightPRRequests = new Map<
  string,
  { promise: Promise<PRInfo | null>; force: boolean; generation: number }
>()
const inflightIssueRequests = new Map<string, Promise<IssueInfo | null>>()
const inflightChecksRequests = new Map<string, Promise<PRCheckDetail[]>>()
const inflightCommentsRequests = new Map<string, Promise<PRComment[]>>()
type InflightWorkItems = {
  promise: Promise<GitHubWorkItem[]>
  force: boolean
}
const inflightWorkItemsRequests = new Map<string, InflightWorkItems>()
const prRequestGenerations = new Map<string, number>()

// Why: cap in-flight cross-repo fan-out and hover-prefetches at the renderer
// boundary — the main-side gate is behind the IPC queue, so it can't see a
// stampede until the calls are already mid-flight. 8 balances responsiveness
// against gh rate-limit pressure.
const WORK_ITEM_FETCH_CONCURRENCY = 8
let workItemFetchInFlight = 0
const workItemFetchWaiters: (() => void)[] = []

async function acquireWorkItemSlot(): Promise<void> {
  if (workItemFetchInFlight < WORK_ITEM_FETCH_CONCURRENCY) {
    workItemFetchInFlight += 1
    return
  }
  await new Promise<void>((resolve) => workItemFetchWaiters.push(resolve))
  // Why: resolver has already claimed the slot on our behalf, so we don't
  // re-increment here. Pairing convention: acquireWorkItemSlot + releaseWorkItemSlot.
}

function releaseWorkItemSlot(): void {
  const next = workItemFetchWaiters.shift()
  if (next) {
    // Hand the slot off directly — net count unchanged — so we can't race a
    // third caller into the cap between decrement and resolve.
    next()
    return
  }
  workItemFetchInFlight -= 1
}

function workItemsCacheKey(repoPath: string, limit: number, query: string): string {
  return `${repoPath}::${limit}::${query}`
}

// Why: 500 entries is generous enough that active developers will never hit it
// during normal use, but prevents the cache from growing without bound across
// many repos and branches over a long-running session.
const MAX_CACHE_ENTRIES = 500

function isFresh<T>(entry: CacheEntry<T> | undefined, ttl = CACHE_TTL): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < ttl
}

/**
 * Evict the oldest entries from a cache record when it exceeds the max size.
 * Returns a pruned copy, or the original reference if no eviction was needed.
 */
function evictStaleEntries<T>(
  cache: Record<string, CacheEntry<T>>,
  maxEntries = MAX_CACHE_ENTRIES
): Record<string, CacheEntry<T>> {
  const keys = Object.keys(cache)
  if (keys.length <= maxEntries) {
    return cache
  }
  const sorted = keys
    .map((k) => ({ key: k, fetchedAt: cache[k].fetchedAt }))
    .sort((a, b) => b.fetchedAt - a.fetchedAt)
  const keep = new Set(sorted.slice(0, maxEntries).map((e) => e.key))
  const pruned: Record<string, CacheEntry<T>> = {}
  for (const k of keep) {
    pruned[k] = cache[k]
  }
  return pruned
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function debouncedSaveCache(state: AppState): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    window.api.cache.setGitHub({
      cache: {
        pr: state.prCache,
        issue: state.issueCache
      }
    })
  }, 1000) // Save at most once per second
}

export type GitHubSlice = {
  prCache: Record<string, CacheEntry<PRInfo>>
  issueCache: Record<string, CacheEntry<IssueInfo>>
  checksCache: Record<string, CacheEntry<PRCheckDetail[]>>
  commentsCache: Record<string, CacheEntry<PRComment[]>>
  // Why: keyed by repoPath + limit + query so the NewWorkspace page can render
  // from cache instantly on mount (and on hover-prefetch from sidebar buttons)
  // while a background refresh keeps the list fresh.
  workItemsCache: Record<string, CacheEntry<GitHubWorkItem[]>>
  fetchPRForBranch: (
    repoPath: string,
    branch: string,
    options?: FetchOptions
  ) => Promise<PRInfo | null>
  fetchIssue: (repoPath: string, number: number) => Promise<IssueInfo | null>
  fetchPRChecks: (
    repoPath: string,
    prNumber: number,
    branch?: string,
    headSha?: string,
    options?: FetchOptions
  ) => Promise<PRCheckDetail[]>
  fetchPRComments: (
    repoPath: string,
    prNumber: number,
    options?: FetchOptions
  ) => Promise<PRComment[]>
  resolveReviewThread: (
    repoPath: string,
    prNumber: number,
    threadId: string,
    resolve: boolean
  ) => Promise<boolean>
  initGitHubCache: () => Promise<void>
  refreshAllGitHub: () => void
  refreshGitHubForWorktree: (worktreeId: string) => void
  refreshGitHubForWorktreeIfStale: (worktreeId: string) => void
  /**
   * Why: returns cached work items immediately (null if none) and fires a
   * background refresh when stale. Callers can render the cached list while
   * the SWR revalidate hydrates the latest.
   */
  getCachedWorkItems: (repoPath: string, limit: number, query: string) => GitHubWorkItem[] | null
  fetchWorkItems: (
    repoId: string,
    repoPath: string,
    limit: number,
    query: string,
    options?: FetchOptions
  ) => Promise<GitHubWorkItem[]>
  /**
   * Why: fan out a single work-item query across multiple repos. Partial
   * failures don't reject — a repo that both fails to fetch *and* has no
   * cached fallback contributes nothing and increments `failedCount`, which
   * the caller surfaces as a "N of M repos failed to load" banner. A repo
   * served from stale cache on rejection is NOT counted as failed — matching
   * the single-repo behavior of quietly serving stale data.
   */
  fetchWorkItemsAcrossRepos: (
    repos: { repoId: string; path: string }[],
    limit: number,
    query: string,
    options?: FetchOptions
  ) => Promise<{ items: GitHubWorkItem[]; failedCount: number }>
  /**
   * Fire-and-forget prefetch used by UI entry points (hover/focus of the
   * "new workspace" buttons) to warm the cache before the page mounts.
   */
  prefetchWorkItems: (repoId: string, repoPath: string, limit?: number, query?: string) => void
  patchWorkItem: (itemId: string, patch: Partial<GitHubWorkItem>) => void
}

export const createGitHubSlice: StateCreator<AppState, [], [], GitHubSlice> = (set, get) => ({
  prCache: {},
  issueCache: {},
  checksCache: {},
  commentsCache: {},
  workItemsCache: {},

  getCachedWorkItems: (repoPath, limit, query) => {
    const key = workItemsCacheKey(repoPath, limit, query)
    return get().workItemsCache[key]?.data ?? null
  },

  fetchWorkItems: async (repoId, repoPath, limit, query, options): Promise<GitHubWorkItem[]> => {
    const key = workItemsCacheKey(repoPath, limit, query)
    const cached = get().workItemsCache[key]
    if (!options?.force && isFresh(cached, WORK_ITEMS_CACHE_TTL)) {
      return cached.data ?? []
    }

    const existing = inflightWorkItemsRequests.get(key)
    if (existing) {
      // Why: a user-initiated refresh (force=true) must not silently dedupe to
      // a non-forcing fetch already in flight — the result would be no fresher
      // than what the user just asked to invalidate. Wait for the non-forcing
      // request to settle (success or failure — we discard the result either
      // way), then fall through to issue a new forced request. Non-forcing
      // callers continue to dedupe onto any in-flight request as before.
      if (options?.force && !existing.force) {
        await existing.promise.catch(() => {})
      } else {
        return existing.promise
      }
    }

    const request = (async () => {
      await acquireWorkItemSlot()
      try {
        const raw = (await window.api.gh.listWorkItems({
          repoPath,
          limit,
          query: query || undefined
        })) as Omit<GitHubWorkItem, 'repoId'>[]
        // Why: stamp repoId at the renderer fetch boundary so every downstream
        // consumer (cross-repo merge, row rendering, drawer) can rely on the
        // field being present. Main doesn't know Orca's Repo.id.
        const items: GitHubWorkItem[] = raw.map((item) => ({ ...item, repoId }))
        set((s) => ({
          workItemsCache: {
            ...s.workItemsCache,
            [key]: { data: items, fetchedAt: Date.now() }
          }
        }))
        return items
      } catch (err) {
        // Why: surface the error to the caller; keep stale cache entry so the
        // UI can continue to render something useful while the user retries.
        console.error('Failed to fetch GitHub work items:', err)
        throw err
      } finally {
        releaseWorkItemSlot()
        inflightWorkItemsRequests.delete(key)
      }
    })()

    inflightWorkItemsRequests.set(key, {
      promise: request,
      force: Boolean(options?.force)
    })
    return request
  },

  fetchWorkItemsAcrossRepos: async (repos, limit, query, options) => {
    const state = get()
    let failedCount = 0
    const perRepoResults = await Promise.all(
      repos.map(async (r) => {
        try {
          return await state.fetchWorkItems(r.repoId, r.path, limit, query, options)
        } catch (err) {
          // Why: fall back to any cache entry (stale or not) before declaring
          // this repo failed. Matches single-repo behavior of silently serving
          // stale data on error. A repo is only counted as failed when it has
          // nothing at all to contribute.
          const key = workItemsCacheKey(r.path, limit, query)
          const cached = get().workItemsCache[key]?.data
          if (cached) {
            console.warn(`[workItems] ${r.repoId} failed, serving cached:`, err)
            return cached
          }
          console.warn(`[workItems] ${r.repoId} failed:`, err)
          failedCount += 1
          return [] as GitHubWorkItem[]
        }
      })
    )
    const merged = sortWorkItemsByUpdatedAt(perRepoResults.flat()).slice(0, limit)
    return { items: merged, failedCount }
  },

  prefetchWorkItems: (repoId, repoPath, limit = 36, query = '') => {
    const key = workItemsCacheKey(repoPath, limit, query)
    const cached = get().workItemsCache[key]
    // Skip when the cache is fresh or a request is already in flight.
    if (isFresh(cached, WORK_ITEMS_CACHE_TTL) || inflightWorkItemsRequests.has(key)) {
      return
    }
    void get()
      .fetchWorkItems(repoId, repoPath, limit, query)
      .catch(() => {})
  },

  initGitHubCache: async () => {
    try {
      const persisted = await window.api.cache.getGitHub()
      if (persisted) {
        set({
          prCache: persisted.pr || {},
          issueCache: persisted.issue || {}
        })
      }
    } catch (err) {
      console.error('Failed to load GitHub cache from disk:', err)
    }
  },

  fetchPRForBranch: async (repoPath, branch, options): Promise<PRInfo | null> => {
    const cacheKey = `${repoPath}::${branch}`
    const cached = get().prCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data
    }

    const inflightRequest = inflightPRRequests.get(cacheKey)
    if (inflightRequest && (!options?.force || inflightRequest.force)) {
      return inflightRequest.promise
    }

    const generation = (prRequestGenerations.get(cacheKey) ?? 0) + 1
    prRequestGenerations.set(cacheKey, generation)

    const request = (async () => {
      try {
        const pr = await window.api.gh.prForBranch({ repoPath, branch })
        if (prRequestGenerations.get(cacheKey) === generation) {
          set((s) => ({
            prCache: { ...s.prCache, [cacheKey]: { data: pr, fetchedAt: Date.now() } }
          }))
          debouncedSaveCache(get())
        }
        return pr
      } catch (err) {
        console.error('Failed to fetch PR:', err)
        if (prRequestGenerations.get(cacheKey) === generation) {
          set((s) => ({
            prCache: { ...s.prCache, [cacheKey]: { data: null, fetchedAt: Date.now() } }
          }))
          debouncedSaveCache(get())
        }
        return null
      } finally {
        const activeRequest = inflightPRRequests.get(cacheKey)
        if (activeRequest?.generation === generation) {
          inflightPRRequests.delete(cacheKey)
        }
      }
    })()

    inflightPRRequests.set(cacheKey, {
      promise: request,
      force: Boolean(options?.force),
      generation
    })
    return request
  },

  fetchIssue: async (repoPath, number) => {
    const cacheKey = `${repoPath}::${number}`
    const cached = get().issueCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data
    }

    const inflightRequest = inflightIssueRequests.get(cacheKey)
    if (inflightRequest) {
      return inflightRequest
    }

    const request = (async () => {
      try {
        const issue = await window.api.gh.issue({ repoPath, number })
        set((s) => ({
          issueCache: { ...s.issueCache, [cacheKey]: { data: issue, fetchedAt: Date.now() } }
        }))
        debouncedSaveCache(get())
        return issue
      } catch (err) {
        console.error('Failed to fetch issue:', err)
        set((s) => ({
          issueCache: { ...s.issueCache, [cacheKey]: { data: null, fetchedAt: Date.now() } }
        }))
        debouncedSaveCache(get())
        return null
      } finally {
        inflightIssueRequests.delete(cacheKey)
      }
    })()

    inflightIssueRequests.set(cacheKey, request)
    return request
  },

  fetchPRChecks: async (repoPath, prNumber, branch, headSha, options): Promise<PRCheckDetail[]> => {
    const cacheKey = `${repoPath}::pr-checks::${prNumber}`
    const cached = get().checksCache[cacheKey]
    if (!options?.force && isFresh(cached, CHECKS_CACHE_TTL)) {
      const cachedChecks = cached.data ?? []
      const prStatusUpdate = syncPRChecksStatus(get(), repoPath, branch, cachedChecks)
      if (prStatusUpdate) {
        set(prStatusUpdate)
        debouncedSaveCache(get())
      }
      return cachedChecks
    }

    const inflightRequest = inflightChecksRequests.get(cacheKey)
    if (inflightRequest) {
      return inflightRequest
    }

    const request = (async () => {
      try {
        const checks = (await window.api.gh.prChecks({
          repoPath,
          prNumber,
          headSha,
          noCache: options?.force
        })) as PRCheckDetail[]
        set((s) => {
          const nextState: Partial<AppState> = {
            checksCache: { ...s.checksCache, [cacheKey]: { data: checks, fetchedAt: Date.now() } }
          }

          const prStatusUpdate = syncPRChecksStatus(s, repoPath, branch, checks)
          if (prStatusUpdate?.prCache) {
            nextState.prCache = prStatusUpdate.prCache
          }

          return nextState
        })
        debouncedSaveCache(get())
        return checks
      } catch (err) {
        console.error('Failed to fetch PR checks:', err)
        return get().checksCache[cacheKey]?.data ?? []
      } finally {
        inflightChecksRequests.delete(cacheKey)
      }
    })()

    inflightChecksRequests.set(cacheKey, request)
    return request
  },

  fetchPRComments: async (repoPath, prNumber, options): Promise<PRComment[]> => {
    const cacheKey = `${repoPath}::pr-comments::${prNumber}`
    const cached = get().commentsCache[cacheKey]
    if (!options?.force && isFresh(cached)) {
      return cached.data ?? []
    }

    const inflightRequest = inflightCommentsRequests.get(cacheKey)
    if (inflightRequest) {
      return inflightRequest
    }

    const request = (async () => {
      try {
        const comments = (await window.api.gh.prComments({
          repoPath,
          prNumber,
          noCache: options?.force
        })) as PRComment[]
        set((s) => ({
          commentsCache: {
            ...s.commentsCache,
            [cacheKey]: { data: comments, fetchedAt: Date.now() }
          }
        }))
        return comments
      } catch (err) {
        console.error('Failed to fetch PR comments:', err)
        return get().commentsCache[cacheKey]?.data ?? []
      } finally {
        inflightCommentsRequests.delete(cacheKey)
      }
    })()

    inflightCommentsRequests.set(cacheKey, request)
    return request
  },

  resolveReviewThread: async (repoPath, prNumber, threadId, resolve) => {
    const cacheKey = `${repoPath}::pr-comments::${prNumber}`

    // Optimistic update: toggle isResolved on all comments in this thread immediately
    // so the UI feels instant. Reverts if the API call fails.
    const prev = get().commentsCache[cacheKey]?.data
    if (prev) {
      set((s) => ({
        commentsCache: {
          ...s.commentsCache,
          [cacheKey]: {
            ...s.commentsCache[cacheKey],
            data: prev.map((c) => (c.threadId === threadId ? { ...c, isResolved: resolve } : c))
          }
        }
      }))
    }

    const ok = await window.api.gh.resolveReviewThread({ repoPath, threadId, resolve })
    if (!ok && prev) {
      // Revert optimistic update on failure
      set((s) => ({
        commentsCache: {
          ...s.commentsCache,
          [cacheKey]: { ...s.commentsCache[cacheKey], data: prev }
        }
      }))
    }
    return ok
  },

  refreshAllGitHub: () => {
    // Invalidate checks and comments caches so they refresh on next access.
    // Also evict old entries from prCache and issueCache to prevent unbounded
    // growth across many repos and branches over a long-running session.
    set((s) => ({
      checksCache: {},
      commentsCache: {},
      prCache: evictStaleEntries(s.prCache),
      issueCache: evictStaleEntries(s.issueCache)
    }))

    // Why: prRequestGenerations tracks generation counters for inflight
    // fetch deduplication. Pruning keys that were just evicted from prCache
    // would race with inflight requests — their generation check would fail
    // and silently discard valid responses. Since each entry is just a number,
    // the memory overhead is negligible; let it shrink naturally as keys stop
    // being fetched. The eviction on prCache/issueCache above is sufficient
    // to bound the dominant source of growth.

    // Only re-fetch PR/issue entries that are already stale — skip fresh ones
    const state = get()
    const now = Date.now()

    for (const worktrees of Object.values(state.worktreesByRepo)) {
      for (const wt of worktrees) {
        const repo = state.repos.find((r) => r.id === wt.repoId)
        if (!repo) {
          continue
        }

        const branch = wt.branch.replace(/^refs\/heads\//, '')
        if (!wt.isBare && branch) {
          const prKey = `${repo.path}::${branch}`
          const prEntry = state.prCache[prKey]
          if (!prEntry || now - prEntry.fetchedAt >= CACHE_TTL) {
            void get().fetchPRForBranch(repo.path, branch)
          }
        }
        if (wt.linkedIssue) {
          const issueKey = `${repo.path}::${wt.linkedIssue}`
          const issueEntry = state.issueCache[issueKey]
          if (!issueEntry || now - issueEntry.fetchedAt >= CACHE_TTL) {
            void get().fetchIssue(repo.path, wt.linkedIssue)
          }
        }
      }
    }
  },

  refreshGitHubForWorktree: (worktreeId) => {
    const state = get()
    let worktree: Worktree | undefined
    for (const worktrees of Object.values(state.worktreesByRepo)) {
      worktree = worktrees.find((w) => w.id === worktreeId)
      if (worktree) {
        break
      }
    }
    if (!worktree) {
      return
    }

    const repo = state.repos.find((r) => r.id === worktree.repoId)
    if (!repo) {
      return
    }

    // Invalidate this worktree's cache entries
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const prKey = `${repo.path}::${branch}`
    const issueKey = worktree.linkedIssue ? `${repo.path}::${worktree.linkedIssue}` : ''

    set((s) => {
      const updates: Partial<AppState> = {}
      if (s.prCache[prKey]) {
        updates.prCache = { ...s.prCache, [prKey]: { ...s.prCache[prKey], fetchedAt: 0 } }
      }
      if (issueKey && s.issueCache[issueKey]) {
        updates.issueCache = {
          ...s.issueCache,
          [issueKey]: { ...s.issueCache[issueKey], fetchedAt: 0 }
        }
      }
      return updates
    })

    // Re-fetch (skip when branch is empty — detached HEAD during rebase)
    if (!worktree.isBare && branch) {
      void get().fetchPRForBranch(repo.path, branch, { force: true })
    }
    if (worktree.linkedIssue) {
      void get().fetchIssue(repo.path, worktree.linkedIssue)
    }
  },

  patchWorkItem: (itemId, patch) => {
    set((s) => {
      const nextCache = { ...s.workItemsCache }
      let changed = false
      for (const key of Object.keys(nextCache)) {
        const entry = nextCache[key]
        if (!entry?.data) {
          continue
        }
        const idx = entry.data.findIndex((item) => item.id === itemId)
        if (idx === -1) {
          continue
        }
        const updatedItems = [...entry.data]
        updatedItems[idx] = { ...updatedItems[idx], ...patch }
        nextCache[key] = { ...entry, data: updatedItems }
        changed = true
      }
      return changed ? { workItemsCache: nextCache } : {}
    })
  },

  // Why: worktree switches previously force-refreshed GitHub data on every
  // click, bypassing the 5-min TTL. This variant only fetches when stale,
  // avoiding unnecessary API calls and latency during rapid switching.
  refreshGitHubForWorktreeIfStale: (worktreeId) => {
    const state = get()
    let worktree: Worktree | undefined
    for (const worktrees of Object.values(state.worktreesByRepo)) {
      worktree = worktrees.find((w) => w.id === worktreeId)
      if (worktree) {
        break
      }
    }
    if (!worktree) {
      return
    }

    const repo = state.repos.find((r) => r.id === worktree.repoId)
    if (!repo) {
      return
    }

    const now = Date.now()
    const branch = worktree.branch.replace(/^refs\/heads\//, '')
    const prKey = `${repo.path}::${branch}`
    const prEntry = state.prCache[prKey]
    const prStale = !prEntry || now - prEntry.fetchedAt >= CACHE_TTL

    if (!worktree.isBare && branch && prStale) {
      void get().fetchPRForBranch(repo.path, branch, { force: true })
    }

    if (worktree.linkedIssue) {
      const issueKey = `${repo.path}::${worktree.linkedIssue}`
      const issueEntry = state.issueCache[issueKey]
      if (!issueEntry || now - issueEntry.fetchedAt >= CACHE_TTL) {
        void get().fetchIssue(repo.path, worktree.linkedIssue)
      }
    }
  }
})
