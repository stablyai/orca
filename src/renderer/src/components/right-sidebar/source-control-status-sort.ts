import type { GitStatusEntry } from '../../../../shared/types'

export function compareGitStatusEntries(a: GitStatusEntry, b: GitStatusEntry): number {
  return (
    getConflictSortRank(a) - getConflictSortRank(b) ||
    a.path.localeCompare(b.path, undefined, { numeric: true })
  )
}

function getConflictSortRank(entry: GitStatusEntry): number {
  if (entry.conflictStatus === 'unresolved') {
    return 0
  }
  if (entry.conflictStatus === 'resolved_locally') {
    return 1
  }
  return 2
}
