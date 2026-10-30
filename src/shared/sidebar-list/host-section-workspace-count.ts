import type { Row } from './row-types'

/** A host section's workspace badge count. */
export function countWorkspaceRows(rows: readonly Row[]): number {
  // Collapsed groups have no item rows; count headers so populated projects do not show a zero host badge.
  let count = 0
  const seenWorktreeIds = new Set<string>()
  let pendingHeader: Extract<Row, { type: 'header' }> | null = null
  let pendingHeaderHadWorkspaces = false
  const flushHeader = (): void => {
    if (pendingHeader && !pendingHeaderHadWorkspaces) {
      if (pendingHeader.worktreeIds) {
        const headerWorktreeIds = new Set(pendingHeader.worktreeIds)
        for (const worktreeId of pendingHeader.worktreeIds) {
          if (!seenWorktreeIds.has(worktreeId)) {
            count += 1
            seenWorktreeIds.add(worktreeId)
          }
        }
        // Folder workspaces contribute to the header count but have no worktree id.
        count += Math.max(0, pendingHeader.count - headerWorktreeIds.size)
      } else {
        count += pendingHeader.count
      }
    }
    pendingHeader = null
    pendingHeaderHadWorkspaces = false
  }
  for (const row of rows) {
    if (row.type === 'header') {
      // A nested header means its enclosing group is expanded, not collapsed.
      if (pendingHeader && (row.projectGroupDepth ?? 0) > (pendingHeader.projectGroupDepth ?? 0)) {
        pendingHeaderHadWorkspaces = true
      }
      flushHeader()
      pendingHeader = row
      continue
    }
    if (row.type === 'item') {
      if (!seenWorktreeIds.has(row.worktree.id)) {
        count += 1
        seenWorktreeIds.add(row.worktree.id)
      }
      pendingHeaderHadWorkspaces = pendingHeader !== null
      continue
    }
    if (row.type === 'folder-workspace') {
      count += 1
      pendingHeaderHadWorkspaces = pendingHeader !== null
    }
  }
  flushHeader()
  return count
}
