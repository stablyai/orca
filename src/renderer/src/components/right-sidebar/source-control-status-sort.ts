import type { GitStatusEntry } from '../../../../shared/types'

// Why hoisted: localeCompare with an options object resolves a fresh ICU collator
// on every comparison, so a changed-file sort paid for one per O(n log n) step.
export const sourceControlPathCollator = new Intl.Collator(undefined, { numeric: true })

export function compareGitStatusEntries(a: GitStatusEntry, b: GitStatusEntry): number {
  return (
    getConflictSortRank(a) - getConflictSortRank(b) ||
    sourceControlPathCollator.compare(a.path, b.path)
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
