/** Count folder workspaces too; active filters must not replace surviving rows with an empty state. */
export function shouldFiltersHideAllRows(counts: {
  hasFilters: boolean
  visibleWorktreeCount: number
  visibleFolderWorkspaceCount: number
  placeholderRepoCount: number
  externalWorktreeNoticeCount: number
}): boolean {
  return (
    counts.hasFilters &&
    counts.visibleWorktreeCount === 0 &&
    counts.visibleFolderWorkspaceCount === 0 &&
    counts.placeholderRepoCount === 0 &&
    counts.externalWorktreeNoticeCount === 0
  )
}
