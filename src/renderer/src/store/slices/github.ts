import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PRInfo, IssueInfo, PRCheckDetail, Worktree } from '../../../../shared/types'
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

const inflightPRRequests = new Map<
  string,
  { promise: Promise<PRInfo | null>; force: boolean; generation: number }
>()
const inflightIssueRequests = new Map<string, Promise<IssueInfo | null>>()
const inflightChecksRequests = new Map<string, Promise<PRCheckDetail[]>>()
const prRequestGenerations = new Map<string, number>()

function isFresh<T>(entry: CacheEntry<T> | undefined, ttl = CACHE_TTL): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < ttl
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
  initGitHubCache: () => Promise<void>
  refreshAllGitHub: () => void
  refreshGitHubForWorktree: (worktreeId: string) => void
}

export const createGitHubSlice: StateCreator<AppState, [], [], GitHubSlice> = (set, get) => ({
  prCache: {},
  issueCache: {},
  checksCache: {},

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

  refreshAllGitHub: () => {
    // Invalidate checks cache so it refreshes on next access
    set({ checksCache: {} })

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
  }
})
