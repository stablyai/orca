import type { GitStatusEntry } from './git-status-types'
import {
  isStageableStatusEntry,
  isWorktreeUndiscardableGitlink
} from './source-control-discard-all-sequence'

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
    !isWorktreeUndiscardableGitlink(entry) &&
    (entry.area === 'unstaged' || entry.area === 'untracked')
  )
}

export const CONFLICT_RESOLUTIONS = ['mark_resolved', 'keep_file', 'keep_deletion'] as const
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number]

/** Staging the worktree is Git's resolution; a missing worktree file can only resolve as a deletion. */
export function getConflictResolutions(entry: GitStatusEntry): ConflictResolution[] {
  if (entry.conflictStatus !== 'unresolved' || !entry.conflictKind || entry.submoduleRoot) {
    return []
  }
  if (entry.status === 'deleted') {
    return ['keep_deletion']
  }
  if (entry.conflictKind === 'deleted_by_us' || entry.conflictKind === 'deleted_by_them') {
    return ['keep_file', 'keep_deletion']
  }
  return ['mark_resolved']
}
