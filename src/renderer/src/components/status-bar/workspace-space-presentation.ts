import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'

export type WorkspaceSpaceSortKey = 'size' | 'name' | 'repo' | 'activity'
export type WorkspaceSpaceSortDirection = 'asc' | 'desc'

export function getWorkspaceSpaceSearchText(worktree: WorkspaceSpaceWorktree): string {
  return [
    worktree.displayName,
    worktree.repoDisplayName,
    worktree.path,
    worktree.branch,
    worktree.status
  ]
    .join(' ')
    .toLowerCase()
}

function compareRows(
  left: WorkspaceSpaceWorktree,
  right: WorkspaceSpaceWorktree,
  sortKey: WorkspaceSpaceSortKey
): number {
  switch (sortKey) {
    case 'size':
      return left.sizeBytes - right.sizeBytes
    case 'name':
      return left.displayName.localeCompare(right.displayName)
    case 'repo':
      return (
        left.repoDisplayName.localeCompare(right.repoDisplayName) ||
        left.displayName.localeCompare(right.displayName)
      )
    case 'activity':
      return left.lastActivityAt - right.lastActivityAt
  }
}

export function sortWorkspaceSpaceRows(
  rows: readonly WorkspaceSpaceWorktree[],
  sortKey: WorkspaceSpaceSortKey,
  direction: WorkspaceSpaceSortDirection
): WorkspaceSpaceWorktree[] {
  const multiplier = direction === 'asc' ? 1 : -1
  return [...rows].sort((left, right) => {
    const primary = compareRows(left, right, sortKey) * multiplier
    return (
      primary ||
      right.sizeBytes - left.sizeBytes ||
      left.displayName.localeCompare(right.displayName)
    )
  })
}

export function filterWorkspaceSpaceRows(
  rows: readonly WorkspaceSpaceWorktree[],
  query: string,
  onlyDeletable: boolean
): WorkspaceSpaceWorktree[] {
  const normalizedQuery = query.trim().toLowerCase()
  return rows.filter((row) => {
    if (onlyDeletable && !row.canDelete) {
      return false
    }
    if (!normalizedQuery) {
      return true
    }
    return getWorkspaceSpaceSearchText(row).includes(normalizedQuery)
  })
}

export function getSelectedDeletableWorkspaceIds(
  rows: readonly WorkspaceSpaceWorktree[],
  selectedIds: ReadonlySet<string>,
  isWorktreeDeleting: (worktreeId: string) => boolean = () => false
): string[] {
  return rows
    .filter(
      (row) =>
        row.canDelete &&
        row.status === 'ok' &&
        selectedIds.has(row.worktreeId) &&
        !isWorktreeDeleting(row.worktreeId)
    )
    .map((row) => row.worktreeId)
}

export function getVisibleDeletableWorkspaceIds(
  rows: readonly WorkspaceSpaceWorktree[],
  isWorktreeDeleting: (worktreeId: string) => boolean = () => false
): string[] {
  return rows
    .filter((row) => row.canDelete && row.status === 'ok' && !isWorktreeDeleting(row.worktreeId))
    .map((row) => row.worktreeId)
}
