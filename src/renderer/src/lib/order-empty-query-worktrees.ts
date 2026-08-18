import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import { isPaletteCurrentWorktree } from './palette-repo-resolution'
import { compareWorktreeDisplayName } from './worktree-display-name-order'

export type OrderEmptyQueryInputs = {
  visibleWorktrees: readonly Worktree[]
  activeWorktreeId: string | null
  /** Host of the active workspace. Omit to fall back to bare-id matching (STA-4343). */
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
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
  const {
    visibleWorktrees,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    lastVisitedAtByWorktreeId
  } = inputs
  // Why the host too (STA-4343): `repoId::path` repeats across hosts, so filtering on the
  // bare id drops BOTH same-id rows as "current" and the other host becomes unreachable.
  const switchable = visibleWorktrees.filter(
    (w) => !isPaletteCurrentWorktree(w, activeWorktreeId, activeWorkspaceExecutionHostId)
  )
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
    return compareWorktreeDisplayName(a, b)
  })
  return {
    visibleWorktreesForState: visibleWorktrees,
    switchableWorktreesForRows: sorted
  }
}
