import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import type { Worktree, Repo, TerminalTab } from '../../../../shared/types'

type SortBy = 'name' | 'recent' | 'repo'

type PRCacheEntry = { data: object | null; fetchedAt: number }
export type RecentSortOverride = {
  worktree: Worktree
  tabs: TerminalTab[]
  hasRecentPRSignal: boolean
}

function branchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export function hasRecentPRSignal(
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null
): boolean {
  const repo = repoMap.get(worktree.repoId)
  const branch = branchDisplayName(worktree.branch)
  if (!repo || !branch) {
    return worktree.linkedPR !== null
  }

  const cacheKey = `${repo.path}::${branch}`
  const cachedEntry = prCache?.[cacheKey]
  if (cachedEntry) {
    return Boolean(cachedEntry.data)
  }

  return worktree.linkedPR !== null
}

function computeSmartScoreFromSignals(
  worktree: Worktree,
  tabs: TerminalTab[],
  hasRecentPR: boolean,
  now: number
): number {
  const liveTabs = tabs.filter((t) => t.ptyId)

  let score = 0

  const isRunning = liveTabs.some((t) => detectAgentStatusFromTitle(t.title) === 'working')
  if (isRunning) {
    score += 60
  }

  const needsAttention = liveTabs.some((t) => detectAgentStatusFromTitle(t.title) === 'permission')
  if (needsAttention) {
    score += 35
  }

  if (worktree.isUnread) {
    score += 18
  }

  if (liveTabs.length > 0) {
    score += 12
  }

  if (hasRecentPR) {
    score += 10
  }

  if (worktree.linkedIssue !== null) {
    score += 6
  }

  const activityAge = now - (worktree.lastActivityAt || 0)
  if (worktree.lastActivityAt > 0) {
    const ONE_DAY = 24 * 60 * 60 * 1000
    score += 24 * Math.max(0, 1 - activityAge / ONE_DAY)
  }

  return score
}

function getRecentSortCandidate(
  worktree: Worktree,
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null,
  recentSortOverrides: Record<string, RecentSortOverride> | null
): RecentSortOverride {
  return (
    recentSortOverrides?.[worktree.id] ?? {
      worktree,
      tabs: tabsByWorktree?.[worktree.id] ?? [],
      hasRecentPRSignal: hasRecentPRSignal(worktree, repoMap, prCache)
    }
  )
}

/**
 * Build a comparator for sorting worktrees based on the current sort mode.
 */
export function buildWorktreeComparator(
  sortBy: SortBy,
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null,
  now: number = Date.now(),
  recentSortOverrides: Record<string, RecentSortOverride> | null = null
): (a: Worktree, b: Worktree) => number {
  return (a, b) => {
    switch (sortBy) {
      case 'name':
        return a.displayName.localeCompare(b.displayName)
      case 'recent': {
        const recentA = getRecentSortCandidate(
          a,
          tabsByWorktree,
          repoMap,
          prCache,
          recentSortOverrides
        )
        const recentB = getRecentSortCandidate(
          b,
          tabsByWorktree,
          repoMap,
          prCache,
          recentSortOverrides
        )
        // Recent means meaningful recent work, not selection time.
        return (
          computeSmartScoreFromSignals(
            recentB.worktree,
            recentB.tabs,
            recentB.hasRecentPRSignal,
            now
          ) -
            computeSmartScoreFromSignals(
              recentA.worktree,
              recentA.tabs,
              recentA.hasRecentPRSignal,
              now
            ) ||
          recentB.worktree.lastActivityAt - recentA.worktree.lastActivityAt ||
          a.displayName.localeCompare(b.displayName)
        )
      }
      case 'repo': {
        const ra = repoMap.get(a.repoId)?.displayName ?? ''
        const rb = repoMap.get(b.repoId)?.displayName ?? ''
        const cmp = ra.localeCompare(rb)
        return cmp !== 0 ? cmp : a.displayName.localeCompare(b.displayName)
      }
      default:
        return 0
    }
  }
}

/**
 * Compute a recent-work score for a worktree.
 * Higher score = higher in the list.
 *
 * Scoring:
 *   running AI job    → +60
 *   needs attention   → +35
 *   unread            → +18
 *   open terminal     → +12
 *   live branch PR    → +10
 *   linked issue      → +6
 *   recent activity   → +24 (decays over 24 hours)
 */
export function computeSmartScore(
  worktree: Worktree,
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  repoMap: Map<string, Repo> | null,
  prCache: Record<string, PRCacheEntry> | null,
  now: number = Date.now()
): number {
  return computeSmartScoreFromSignals(
    worktree,
    tabsByWorktree?.[worktree.id] ?? [],
    // Why: branch-aware PR cache is the freshest signal, but off-screen
    // worktrees may not have fetched it yet. Fall back to persisted linkedPR
    // only while that branch cache entry is still cold so recent sorting stays
    // stable on launch without reviving stale PRs after a cache miss resolves.
    repoMap ? hasRecentPRSignal(worktree, repoMap, prCache) : worktree.linkedPR !== null,
    now
  )
}
