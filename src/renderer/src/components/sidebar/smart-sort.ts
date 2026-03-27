import { detectAgentStatusFromTitle } from '@/lib/agent-status'
import type { Worktree, Repo, TerminalTab } from '../../../../shared/types'

type SortBy = 'name' | 'recent' | 'smart' | 'repo'

/**
 * Build a comparator for sorting worktrees based on the current sort mode.
 */
export function buildWorktreeComparator(
  sortBy: SortBy,
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  repoMap: Map<string, Repo>,
  activeWorktreeId: string | null = null
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
        return (
          computeSmartScore(b, tabsByWorktree, activeWorktreeId) -
            computeSmartScore(a, tabsByWorktree, activeWorktreeId) ||
          b.lastActivityAt - a.lastActivityAt ||
          b.sortOrder - a.sortOrder ||
          a.displayName.localeCompare(b.displayName)
        )
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
 *   active worktree   → +80
 *   running AI job    → +60
 *   needs attention   → +35
 *   unread            → +18
 *   open terminal     → +12
 *   linked PR         → +10
 *   linked issue      → +6
 *   recent activity   → +24 (decays over 24 hours)
 *   last viewed       → +8  (decays over 12 hours)
 */
export function computeSmartScore(
  worktree: Worktree,
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  activeWorktreeId: string | null = null
): number {
  const tabs = tabsByWorktree?.[worktree.id] ?? []
  const liveTabs = tabs.filter((t) => t.ptyId)
  const now = Date.now()

  let score = 0

  if (worktree.id === activeWorktreeId) {
    score += 80
  }

  // Running: any live PTY with an AI agent actively working
  const isRunning = liveTabs.some((t) => detectAgentStatusFromTitle(t.title) === 'working')
  if (isRunning) {
    score += 60
  }

  // Needs attention: permission prompt in a live agent terminal
  const needsAttention = liveTabs.some((t) => detectAgentStatusFromTitle(t.title) === 'permission')
  if (needsAttention) {
    score += 35
  }

  // Unread
  if (worktree.isUnread) {
    score += 18
  }

  // Live terminals are a strong sign of ongoing work, even if no agent title is detected.
  if (liveTabs.length > 0) {
    score += 12
  }

  if (worktree.linkedPR !== null) {
    score += 10
  }

  if (worktree.linkedIssue !== null) {
    score += 6
  }

  // Recent meaningful activity should stay relevant for the rest of the day,
  // not vanish after an hour.
  const activityAge = now - (worktree.lastActivityAt || 0)
  if (worktree.lastActivityAt > 0) {
    const ONE_DAY = 24 * 60 * 60 * 1000
    score += 24 * Math.max(0, 1 - activityAge / ONE_DAY)
  }

  // Last viewed matters, but less than actual activity.
  const viewAge = now - (worktree.sortOrder || 0)
  if (worktree.sortOrder > 0) {
    const TWELVE_HOURS = 12 * 60 * 60 * 1000
    score += 8 * Math.max(0, 1 - viewAge / TWELVE_HOURS)
  }

  return score
}
