import type { GitStatusEntry } from './git-status-types'
import { isStageableStatusEntry } from './source-control-discard-all-sequence'

/** Share row/bulk eligibility; submodule-internal rows are read-only because parent Git cannot mutate their working tree. */

export function canStageStatusEntry(entry: GitStatusEntry): boolean {
  return isStageableStatusEntry(entry)
}

export function canUnstageStatusEntry(entry: GitStatusEntry): boolean {
  return entry.area === 'staged' && !entry.submoduleRoot
}

export function canDiscardStatusEntry(entry: GitStatusEntry): boolean {
  return (
    entry.conflictStatus !== 'unresolved' &&
    entry.conflictStatus !== 'resolved_locally' &&
    !entry.submoduleRoot &&
    (entry.area === 'unstaged' || entry.area === 'untracked')
  )
}

// Why: deleted rows and submodule gitlinks are not regular files on disk.
export function canOpenWorkingTreeStatusEntry(
  entry: Pick<GitStatusEntry, 'status' | 'submodule'>
): boolean {
  return entry.status !== 'deleted' && entry.submodule == null
}
