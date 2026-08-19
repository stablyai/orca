import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

/**
 * Which Space rows a delete action applies to.
 *
 * Rows are host-partitioned: two rows can share a `repoId::path` worktree id
 * when the same repo is registered on two execution hosts. Anything feeding a
 * destructive action therefore hands back ROWS, not ids — an id alone cannot say
 * which host's checkout the user pointed at (STA-4343).
 */

/** The selected rows themselves — each keeps its own host (STA-4343). */
export function getWorkspaceSpaceWorktreeIdentity(
  row: Pick<WorkspaceSpaceWorktree, 'worktreeId' | 'executionHostId'>
): string {
  return composeWorktreeHostIdentity(row.executionHostId, row.worktreeId)
}

export function getSelectedDeletableWorkspaceRows(
  rows: readonly WorkspaceSpaceWorktree[],
  selectedIdentities: ReadonlySet<string>,
  isWorktreeDeleting: (row: WorkspaceSpaceWorktree) => boolean = () => false
): WorkspaceSpaceWorktree[] {
  return rows.filter(
    (row) =>
      row.canDelete &&
      row.status === 'ok' &&
      selectedIdentities.has(getWorkspaceSpaceWorktreeIdentity(row)) &&
      !isWorktreeDeleting(row)
  )
}

export function getSelectedDeletableWorkspaceIds(
  rows: readonly WorkspaceSpaceWorktree[],
  selectedIdentities: ReadonlySet<string>,
  isWorktreeDeleting: (row: WorkspaceSpaceWorktree) => boolean = () => false
): string[] {
  return getSelectedDeletableWorkspaceRows(rows, selectedIdentities, isWorktreeDeleting).map(
    (row) => row.worktreeId
  )
}

export function getVisibleDeletableWorkspaceIdentities(
  rows: readonly WorkspaceSpaceWorktree[],
  isWorktreeDeleting: (row: WorkspaceSpaceWorktree) => boolean = () => false
): string[] {
  return rows
    .filter((row) => row.canDelete && row.status === 'ok' && !isWorktreeDeleting(row))
    .map(getWorkspaceSpaceWorktreeIdentity)
}
