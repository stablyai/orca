import type { GitStatusEntry } from '../../../../shared/types'
import { compareFileNames } from '../../../../shared/file-name-sort'

export function compareGitStatusEntries(a: GitStatusEntry, b: GitStatusEntry): number {
  // Why: compareFileNames (not the raw collator) so numeric-collation ties
  // ("2" vs "02") stay a total order shared with the File Explorer.
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
