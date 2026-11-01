import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

/** Host-partitioned scan rows can share workspace IDs; destructive selection must preserve the row’s host. */

/** Qualify selection IDs by host so same-ID checkouts remain independent. */
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
