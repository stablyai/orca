import type { GitStatusEntry } from './git-status-types'
import { compareFileNames } from './file-name-sort'

export function compareGitStatusEntries(a: GitStatusEntry, b: GitStatusEntry): number {
  // Use compareFileNames to break numeric ties (2/02) consistently with File Explorer.
  return getConflictSortRank(a) - getConflictSortRank(b) || compareFileNames(a.path, b.path)
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
