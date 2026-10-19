import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { getWorkspaceLastActiveAt } from '../../../../shared/workspace-last-active'
import { getWorktreeVisitTimestamp } from '@/lib/worktree-visit-recency'

/** Rows with visits counted as activity (switch on; `visits` is undefined otherwise). */
export function withWorkspaceSpaceVisitActivity(
  rows: readonly WorkspaceSpaceWorktree[],
  visits: Readonly<Record<string, number>> | undefined
): readonly WorkspaceSpaceWorktree[] {
  if (!visits) {
    return rows
  }
  return rows.map((row) => {
    const lastActivityAt = getWorkspaceLastActiveAt(
      row.lastActivityAt,
      getWorktreeVisitTimestamp(visits, { id: row.worktreeId, hostId: row.executionHostId })
    )
    return lastActivityAt === row.lastActivityAt ? row : { ...row, lastActivityAt }
  })
}
