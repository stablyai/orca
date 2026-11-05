import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import { isPaletteCurrentWorktree } from './palette-repo-resolution'
import { compareWorktreeDisplayName } from './worktree-display-name-order'
import { getWorktreeVisitTimestamp } from './worktree-visit-recency'

export type OrderEmptyQueryInputs = {
  visibleWorktrees: readonly Worktree[]
  activeWorktreeId: string | null
  /** Host of the active workspace. Omit to fall back to bare-id matching (STA-4343). */
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
  lastVisitedAtByWorktreeId: Record<string, number>
}

export type OrderEmptyQueryResult = {
  /** Keep current workspace in visibility/empty-state counts even though switchable rows exclude it. */
  visibleWorktreesForState: readonly Worktree[]
  /** Switchable rows exclude current workspace; order by visit tier/recency, activity fallback and resolved display label. */
  switchableWorktreesForRows: Worktree[]
}

/** Order visited workspaces ahead of unvisited, then recency/activity and display label (cmd-j-empty-query-ordering.md); retain current in empty-state inputs only. */
export function orderEmptyQueryWorktrees(inputs: OrderEmptyQueryInputs): OrderEmptyQueryResult {
  const {
    visibleWorktrees,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    lastVisitedAtByWorktreeId
  } = inputs
  // Same IDs repeat across hosts; bare-ID filtering would hide the other host’s selectable twin (STA-4343).
  const switchable = visibleWorktrees.filter(
    (w) => !isPaletteCurrentWorktree(w, activeWorktreeId, activeWorkspaceExecutionHostId)
  )
  // Compare visited presence before timestamps so noisy unvisited workspaces cannot outrank deliberate recent SSH focus.
  const sorted = [...switchable].sort((a, b) => {
    const aVisited = getWorktreeVisitTimestamp(lastVisitedAtByWorktreeId, a)
    const bVisited = getWorktreeVisitTimestamp(lastVisitedAtByWorktreeId, b)
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
