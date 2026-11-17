/** Count folder workspaces too; active filters must not replace surviving rows with an empty state. */
export function shouldFiltersHideAllRows(counts: {
  hasFilters: boolean
  totalWorkspaceCount?: number
  visibleWorktreeCount: number
  visibleFolderWorkspaceCount: number
  placeholderRepoCount: number
  importedWorktreeCardCount: number
  visibleProjectGroupCount?: number
}): boolean {
  if (counts.totalWorkspaceCount === 0 && (counts.visibleProjectGroupCount ?? 0) > 0) {
    return false
  }
  return (
    counts.hasFilters &&
    counts.visibleWorktreeCount === 0 &&
    counts.visibleFolderWorkspaceCount === 0 &&
    counts.placeholderRepoCount === 0 &&
    counts.importedWorktreeCardCount === 0
  )
}
