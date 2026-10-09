import { worktreeIdsEqual } from '../../../../../shared/worktree/id'

/**
 * Why: a PTY keeps its spawn-time session id `<spawnWorktreeId>@@<suffix>`, so a
 * terminal that moved to another worktree fails every prefix-based ownership
 * check. The reattach gate must still accept such a session when this pane's own
 * persisted layout binds it AND no tab in another worktree claims it — a stale
 * cross-worktree mapping always has a competing claimant or no layout binding.
 */

type ClaimableTabRow = {
  id: string
  ptyId?: string | null
}

export function collectPtyIdsOwnedByOtherWorktrees(
  state: {
    tabsByWorktree: Record<string, readonly ClaimableTabRow[]> | undefined
    ptyIdsByTabId?: Record<string, readonly string[]> | undefined
  },
  ownWorktreeId: string
): Set<string> {
  const claimed = new Set<string>()
  for (const [worktreeId, rows] of Object.entries(state.tabsByWorktree ?? {})) {
    if (worktreeIdsEqual(worktreeId, ownWorktreeId)) {
      continue
    }
    for (const row of rows) {
      if (row.ptyId) {
        claimed.add(row.ptyId)
      }
      for (const ptyId of state.ptyIdsByTabId?.[row.id] ?? []) {
        claimed.add(ptyId)
      }
    }
  }
  return claimed
}
