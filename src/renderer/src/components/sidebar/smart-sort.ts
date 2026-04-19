import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import { branchName } from '@/lib/git-utils'
import type { Worktree, Repo, TerminalTab } from '../../../../shared/types'

type SortBy = 'name' | 'smart' | 'recent' | 'repo'

type PRCacheEntry = { data: object | null; fetchedAt: number }
export type SmartSortOverride = {
  worktree: Worktree
  tabs: TerminalTab[]
  hasRecentPRSignal: boolean
}

export function hasRecentPRSignal(
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null
): boolean {
  const repo = repoMap.get(worktree.repoId)
  const branch = branchName(worktree.branch)
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
    // Why 36: a just-created worktree has only this signal (no live tab yet,
    // since the PTY spawns asynchronously after creation). Weight must exceed
    // the max passive-signal combination for shutdown worktrees
    // (isUnread 18 + PR 10 + issue 6 = 34) so brand-new worktrees always
    // appear at the top of the "smart" sort immediately.
    score += 36 * Math.max(0, 1 - activityAge / ONE_DAY)
  }

  return score
}

function getSmartSortCandidate(
  worktree: Worktree,
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null,
  smartSortOverrides: Record<string, SmartSortOverride> | null
): SmartSortOverride {
  return (
    smartSortOverrides?.[worktree.id] ?? {
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
  smartSortOverrides: Record<string, SmartSortOverride> | null = null
): (a: Worktree, b: Worktree) => number {
  return (a, b) => {
    switch (sortBy) {
      case 'name':
        return a.displayName.localeCompare(b.displayName)
      case 'smart': {
        const smartA = getSmartSortCandidate(
          a,
          tabsByWorktree,
          repoMap,
          prCache,
          smartSortOverrides
        )
        const smartB = getSmartSortCandidate(
          b,
          tabsByWorktree,
          repoMap,
          prCache,
          smartSortOverrides
        )
        return (
          computeSmartScoreFromSignals(
            smartB.worktree,
            smartB.tabs,
            smartB.hasRecentPRSignal,
            now
          ) -
            computeSmartScoreFromSignals(
              smartA.worktree,
              smartA.tabs,
              smartA.hasRecentPRSignal,
              now
            ) ||
          smartB.worktree.lastActivityAt - smartA.worktree.lastActivityAt ||
          a.displayName.localeCompare(b.displayName)
        )
      }
      case 'recent':
        // Why lastActivityAt (not sortOrder): sortOrder is a snapshot of the
        // smart-sort ranking that only gets repersisted while the user is in
        // "Smart" mode, so it's frozen in Recent mode and ignores new terminal
        // events, meta edits, etc. lastActivityAt is the real "recency" signal
        // — it's bumped by bumpWorktreeActivity (PTY spawn, background events)
        // and by meaningful meta edits (comment, isUnread).
        return b.lastActivityAt - a.lastActivityAt || a.displayName.localeCompare(b.displayName)
      case 'repo': {
        const ra = repoMap.get(a.repoId)?.displayName ?? ''
        const rb = repoMap.get(b.repoId)?.displayName ?? ''
        const cmp = ra.localeCompare(rb)
        return cmp !== 0 ? cmp : a.displayName.localeCompare(b.displayName)
      }
      default: {
        const _exhaustive: never = sortBy
        return _exhaustive
      }
    }
  }
}

/**
 * Sort worktrees by weighted smart-score signals, handling the cold-start /
 * warm distinction in one place. On cold start (no live PTYs yet), falls back
 * to persisted `sortOrder` descending with alphabetical `displayName` fallback.
 * Once any PTY is alive, uses the full smart-score comparator.
 *
 * Both the palette and `getVisibleWorktreeIds()` import this to avoid
 * duplicating the cold/warm branching logic.
 */
export function sortWorktreesSmart(
  worktrees: Worktree[],
  tabsByWorktree: Record<string, TerminalTab[]>,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null
): Worktree[] {
  const hasAnyLivePty = Object.values(tabsByWorktree)
    .flat()
    .some((t) => t.ptyId)

  if (!hasAnyLivePty) {
    // Cold start: use persisted sortOrder snapshot
    return [...worktrees].sort(
      (a, b) => b.sortOrder - a.sortOrder || a.displayName.localeCompare(b.displayName)
    )
  }

  return [...worktrees].sort(
    buildWorktreeComparator('smart', tabsByWorktree, repoMap, prCache, Date.now())
  )
}

/**
 * Compute a recent-work score for a worktree.
 * Higher score = higher in the list.
 *
 * Scoring:
 *   running AI job    → +60
 *   recent activity   → +36 (decays over 24 hours)
 *   needs attention   → +35
 *   unread            → +18
 *   open terminal     → +12
 *   live branch PR    → +10
 *   linked issue      → +6
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
    // only while that branch cache entry is still cold so smart sorting stays
    // stable on launch without reviving stale PRs after a cache miss resolves.
    repoMap ? hasRecentPRSignal(worktree, repoMap, prCache) : worktree.linkedPR !== null,
    now
  )
}
