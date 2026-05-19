import type { Worktree } from '../../../shared/types'

export type OrderEmptyQueryInputs = {
  visibleWorktrees: readonly Worktree[]
  activeWorktreeId: string | null
  lastVisitedAtByWorktreeId: Record<string, number>
}

export type OrderEmptyQueryResult = {
  /** Full visible list (including current). Drives "has any worktrees"
   *  / loading / empty-state decisions so the palette never claims to be
   *  empty just because the only visible worktree is the current one. */
  visibleWorktreesForState: readonly Worktree[]
  /** Switchable rows for the Worktrees section — current worktree excluded,
   *  sorted by focus-recency with lastActivityAt fallback and displayName
   *  tie-breaker. v1 has no "Current" row variant. */
  switchableWorktreesForRows: Worktree[]
}

/**
 * Pure ordering helper for Cmd+J's empty-query Worktrees section.
 * See docs/cmd-j-empty-query-ordering.md — this function encodes the
 * ordering-rule block:
 *   1. primary: lastVisitedAtByWorktreeId[id] (focus recency)
 *   2. fallback: Worktree.lastActivityAt (for never-visited / pre-migration)
 *   3. stable tie-breaker: displayName.localeCompare
 * The current worktree is intentionally excluded from rows but kept in
 * visibleWorktreesForState so empty-state logic isn't affected.
 */
export function orderEmptyQueryWorktrees(inputs: OrderEmptyQueryInputs): OrderEmptyQueryResult {
  const { visibleWorktrees, activeWorktreeId, lastVisitedAtByWorktreeId } = inputs
  const switchable = visibleWorktrees.filter((w) => w.id !== activeWorktreeId)
  // Why: a visited worktree must always outrank a never-visited one,
  // even when the never-visited worktree has a newer lastActivityAt.
  // Mixing the two signals into a single numeric score would let
  // incidental background activity on a local worktree push a just-
  // visited SSH worktree below the fold — the exact bug the feature
  // fixes. Compare presence first, then value within each tier.
  const sorted = [...switchable].sort((a, b) => {
    const aVisited = lastVisitedAtByWorktreeId[a.id]
    const bVisited = lastVisitedAtByWorktreeId[b.id]
    if (aVisited != null && bVisited != null) {
      if (bVisited !== aVisited) {
        return bVisited - aVisited
      }
    } else if (aVisited != null) {
      return -1
    } else if (bVisited != null) {
      return 1
    } else if (b.lastActivityAt !== a.lastActivityAt) {
      return b.lastActivityAt - a.lastActivityAt
    }
    return a.displayName.localeCompare(b.displayName)
  })
  return {
    visibleWorktreesForState: visibleWorktrees,
    switchableWorktreesForRows: sorted
  }
}
