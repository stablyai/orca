import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import type { Worktree, Repo, TerminalTab } from '../../../../shared/types'

type SortBy = 'name' | 'recent' | 'smart' | 'repo'

/**
 * Build a comparator for sorting worktrees based on the current sort mode.
 */
export function buildWorktreeComparator(
  sortBy: SortBy,
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  repoMap: Map<string, Repo>
): (a: Worktree, b: Worktree) => number {
  return (a, b) => {
    switch (sortBy) {
      case 'name':
        return a.displayName.localeCompare(b.displayName)
      case 'recent': {
        // Sort by meaningful activity, NOT by last-viewed timestamp.
        // Active worktrees still pin to top in stable (name) order.
        const aTabs = tabsByWorktree?.[a.id] ?? []
        const bTabs = tabsByWorktree?.[b.id] ?? []
        const aActive = aTabs.some((t) => t.ptyId)
        const bActive = bTabs.some((t) => t.ptyId)
        if (aActive && bActive) {
          return a.displayName.localeCompare(b.displayName)
        }
        if (aActive) {
          return -1
        }
        if (bActive) {
          return 1
        }
        // Fall back to lastActivityAt, then sortOrder for legacy data
        const aActivity = a.lastActivityAt || a.sortOrder
        const bActivity = b.lastActivityAt || b.sortOrder
        return bActivity - aActivity
      }
      case 'smart':
        return computeSmartScore(b, tabsByWorktree) - computeSmartScore(a, tabsByWorktree)
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
 * Compute a smart sort score for a worktree.
 * Higher score = higher in the list.
 *
 * Scoring:
 *   running AI job  → +100
 *   needs attention  → +40  (permission prompt, CI failure)
 *   unread           → +20
 *   recent activity  → +10  (scaled: 10 for just now, decaying over 1 hour)
 *   last viewed      → +1   (scaled: 1 for just now, decaying over 1 hour)
 */
export function computeSmartScore(
  worktree: Worktree,
  tabsByWorktree: Record<string, TerminalTab[]> | null
): number {
  const tabs = tabsByWorktree?.[worktree.id] ?? []
  const liveTabs = tabs.filter((t) => t.ptyId)
  const now = Date.now()

  let score = 0

  // Running: any live PTY with an AI agent actively working
  const isRunning = liveTabs.some((t) => detectAgentStatusFromTitle(t.title) === 'working')
  if (isRunning) {
    score += 100
  } else if (liveTabs.length > 0) {
    // Has live terminals but not actively working — still somewhat relevant
    score += 5
  }

  // Needs attention: permission prompt or CI-related unread
  const needsAttention = liveTabs.some((t) => detectAgentStatusFromTitle(t.title) === 'permission')
  if (needsAttention) {
    score += 40
  }

  // Unread
  if (worktree.isUnread) {
    score += 20
  }

  // Recent meaningful activity (decays over 1 hour)
  const activityAge = now - (worktree.lastActivityAt || 0)
  const ONE_HOUR = 60 * 60 * 1000
  if (worktree.lastActivityAt > 0) {
    score += 10 * Math.max(0, 1 - activityAge / ONE_HOUR)
  }

  // Last viewed (minor tiebreaker, decays over 1 hour)
  const viewAge = now - (worktree.sortOrder || 0)
  if (worktree.sortOrder > 0) {
    score += 1 * Math.max(0, 1 - viewAge / ONE_HOUR)
  }

  return score
}
