import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PRInfo, IssueInfo, Worktree } from '../../../../shared/types'

export type CacheEntry<T> = {
  data: T | null
  fetchedAt: number
}

const CACHE_TTL = 300_000 // 5 minutes (stale data shown instantly, then refreshed)

const inflightPRRequests = new Map<string, Promise<PRInfo | null>>()
const inflightIssueRequests = new Map<string, Promise<IssueInfo | null>>()

function isFresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return entry !== undefined && Date.now() - entry.fetchedAt < CACHE_TTL
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
  fetchPRForBranch: (repoPath: string, branch: string) => Promise<PRInfo | null>
  fetchIssue: (repoPath: string, number: number) => Promise<IssueInfo | null>
  initGitHubCache: () => Promise<void>
  refreshAllGitHub: () => void
  refreshGitHubForWorktree: (worktreeId: string) => void
}

export const createGitHubSlice: StateCreator<AppState, [], [], GitHubSlice> = (set, get) => ({
  prCache: {},
  issueCache: {},

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

  fetchPRForBranch: async (repoPath, branch) => {
    const cacheKey = `${repoPath}::${branch}`
    const cached = get().prCache[cacheKey]
    if (isFresh(cached)) {
      return cached.data
    }

    const inflightRequest = inflightPRRequests.get(cacheKey)
    if (inflightRequest) {
      return inflightRequest
    }

    const request = (async () => {
      try {
        const pr = await window.api.gh.prForBranch({ repoPath, branch })
        set((s) => ({
          prCache: { ...s.prCache, [cacheKey]: { data: pr, fetchedAt: Date.now() } }
        }))
        debouncedSaveCache(get())
        return pr
      } catch (err) {
        console.error('Failed to fetch PR:', err)
        set((s) => ({
          prCache: { ...s.prCache, [cacheKey]: { data: null, fetchedAt: Date.now() } }
        }))
        debouncedSaveCache(get())
        return null
      } finally {
        inflightPRRequests.delete(cacheKey)
      }
    })()

    inflightPRRequests.set(cacheKey, request)
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

  refreshAllGitHub: () => {
    // Invalidate all cache entries so next fetch bypasses TTL
    set((s) => {
      const nextPr: Record<string, CacheEntry<PRInfo>> = {}
      for (const [k, v] of Object.entries(s.prCache)) {
        nextPr[k] = { ...v, fetchedAt: 0 }
      }
      const nextIssue: Record<string, CacheEntry<IssueInfo>> = {}
      for (const [k, v] of Object.entries(s.issueCache)) {
        nextIssue[k] = { ...v, fetchedAt: 0 }
      }
      return { prCache: nextPr, issueCache: nextIssue }
    })

    // Re-fetch all worktrees' PR + issue data
    const state = get()
    for (const worktrees of Object.values(state.worktreesByRepo)) {
      for (const wt of worktrees) {
        const repo = state.repos.find((r) => r.id === wt.repoId)
        if (!repo) {
          continue
        }

        const branch = wt.branch.replace(/^refs\/heads\//, '')
        if (!wt.isBare) {
          void get().fetchPRForBranch(repo.path, branch)
        }
        if (wt.linkedIssue) {
          void get().fetchIssue(repo.path, wt.linkedIssue)
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

    // Re-fetch
    if (!worktree.isBare) {
      void get().fetchPRForBranch(repo.path, branch)
    }
    if (worktree.linkedIssue) {
      void get().fetchIssue(repo.path, worktree.linkedIssue)
    }
  }
})
