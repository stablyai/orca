import { getWorkspaceStatus } from '../../../../shared/workspace-statuses'
import type {
  Worktree,
  WorkspaceStatus,
  WorkspaceStatusDefinition
} from '../../../../shared/worktree/types'

/**
 * Narrows rows to the selected card statuses; an empty selection shows every status.
 *
 * Split out of visible-worktrees to keep that file under the line cap.
 *
 * Why the two arguments fail *open* together: resolving a row's effective status
 * needs the live catalog to fall back on, so ids without the catalog would resolve
 * every row to the default id and collapse the list to one status. Omit either and
 * nothing filters.
 *
 * Why this operates on worktrees rather than ids: two execution hosts can publish
 * the same worktree id (STA-4343), and each of those rows carries its own status.
 * Filtering by id would fold them together and judge both on one row's status.
 */
export function filterWorktreesByWorkspaceStatus(
  worktrees: Worktree[],
  filterWorkspaceStatuses: readonly WorkspaceStatus[] | undefined,
  workspaceStatuses: readonly WorkspaceStatusDefinition[] | undefined
): Worktree[] {
  if (!filterWorkspaceStatuses?.length || !workspaceStatuses) {
    return worktrees
  }
  const selected = new Set(filterWorkspaceStatuses)
  return worktrees.filter((worktree) =>
    selected.has(getWorkspaceStatus(worktree, workspaceStatuses))
  )
}
