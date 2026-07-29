import type { GitStatusEntry } from '../../../../shared/types'
import { isStageableStatusEntry } from './discard-all-sequence'

/**
 * Per-row Source Control action eligibility, centralized so the stage/unstage/
 * discard gates stay consistent between the row UI, bulk selection, and tests.
 * A submodule-internal row (`submoduleRoot` set) is read-only from the parent
 * worktree: the parent repo's git can't stage/unstage/discard changes that live
 * in the submodule's own working tree, so those actions are suppressed here.
 */

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
