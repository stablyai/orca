import type { OrderedGroupEntry } from './project-grouping'

/**
 * Recent rank for a project header. `hasActivity` projects (at least one
 * visible worktree) always sort before fallback projects, regardless of the
 * numeric values — a placeholder's `addedAt` must never outrank real activity.
 * Within each tier, higher timestamps come first.
 */
type RecentRank = { hasActivity: boolean; ts: number }

export function recentRankForEntry(entry: OrderedGroupEntry): RecentRank {
  let max = Number.NEGATIVE_INFINITY
  for (const worktree of entry[1].items) {
    if (worktree.lastActivityAt > max) {
      max = worktree.lastActivityAt
    }
  }
  if (max !== Number.NEGATIVE_INFINITY) {
    // Why: Recent must be timestamp-based, not encounter order — the incoming
    // array is no longer pre-sorted by recency once decoupled from sortBy.
    return { hasActivity: true, ts: max }
  }
  const addedAt = entry[1].repo?.addedAt
  return {
    hasActivity: false,
    ts: typeof addedAt === 'number' ? addedAt : Number.NEGATIVE_INFINITY
  }
}

export function compareRecentRank(a: RecentRank, b: RecentRank): number {
  if (a.hasActivity !== b.hasActivity) {
    return a.hasActivity ? -1 : 1
  }
  return b.ts - a.ts
}
