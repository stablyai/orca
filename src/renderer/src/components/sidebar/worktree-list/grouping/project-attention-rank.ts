import { IDLE, type SmartClass, type WorktreeAttention } from '../../smart-attention'
import type { OrderedGroupEntry } from './project-grouping'

export type ProjectAttentionByWorktree = ReadonlyMap<string, WorktreeAttention>

/** A project's most urgent worktree, in the same terms the Smart worktree sort uses. */
export type ProjectAttentionRank = {
  cls: SmartClass
  attentionTimestamp: number
  lastActivityAt: number
  /** Cold start only: the project's best persisted Smart snapshot rank (worktree sortOrder). */
  coldOrder?: number
}

export function projectAttentionRankForEntry(
  entry: OrderedGroupEntry,
  attentionByWorktree: ProjectAttentionByWorktree | undefined
): ProjectAttentionRank {
  let cls: SmartClass = IDLE.cls
  let attentionTimestamp = 0
  let lastActivityAt = Number.NEGATIVE_INFINITY
  let coldOrder = Number.NEGATIVE_INFINITY
  for (const worktree of entry[1].items) {
    coldOrder = Math.max(coldOrder, worktree.sortOrder)
    const attention = attentionByWorktree?.get(worktree.id) ?? IDLE
    if (
      attention.cls < cls ||
      (attention.cls === cls && attention.attentionTimestamp > attentionTimestamp)
    ) {
      cls = attention.cls
      attentionTimestamp = attention.attentionTimestamp
    }
    if (worktree.lastActivityAt > lastActivityAt) {
      lastActivityAt = worktree.lastActivityAt
    }
  }
  return attentionByWorktree
    ? { cls, attentionTimestamp, lastActivityAt }
    : { cls, attentionTimestamp, lastActivityAt, coldOrder }
}

export function createProjectAttentionRankLookup(
  attentionByWorktree: ProjectAttentionByWorktree | undefined
): (entry: OrderedGroupEntry) => ProjectAttentionRank {
  const ranks = new Map<OrderedGroupEntry, ProjectAttentionRank>()
  return (entry) => {
    const existing = ranks.get(entry)
    if (existing) {
      return existing
    }
    const rank = projectAttentionRankForEntry(entry, attentionByWorktree)
    ranks.set(entry, rank)
    return rank
  }
}

/** Lower class first, then the most recent attention event, then (idle ties) recent activity. */
export function compareProjectAttentionRank(
  a: ProjectAttentionRank,
  b: ProjectAttentionRank
): number {
  if (a.cls !== b.cls) {
    return a.cls - b.cls
  }
  if (a.attentionTimestamp !== b.attentionTimestamp) {
    return b.attentionTimestamp - a.attentionTimestamp
  }
  if (a.coldOrder !== undefined && b.coldOrder !== undefined && a.coldOrder !== b.coldOrder) {
    return a.coldOrder > b.coldOrder ? -1 : 1
  }
  if (a.lastActivityAt === b.lastActivityAt) {
    return 0
  }
  // Why: empty projects carry -Infinity; Infinity - Infinity would be NaN.
  return a.lastActivityAt > b.lastActivityAt ? -1 : 1
}
