/**
 * Whether active filters have hidden every sidebar row, so the Clear Filters
 * empty state should win over any remaining headers.
 *
 * Split out of WorktreeList so the row kinds it counts are testable: folder
 * workspaces were missing from this gate, which meant an account whose only
 * workspaces were folder workspaces lost them to the empty state as soon as any
 * filter — including host scope — was active (#15362).
 */
export function shouldFiltersHideAllRows(counts: {
  hasFilters: boolean
  visibleWorktreeCount: number
  visibleFolderWorkspaceCount: number
  placeholderRepoCount: number
  importedWorktreeCardCount: number
}): boolean {
  return (
    counts.hasFilters &&
    counts.visibleWorktreeCount === 0 &&
    counts.visibleFolderWorkspaceCount === 0 &&
    counts.placeholderRepoCount === 0 &&
    counts.importedWorktreeCardCount === 0
  )
}
