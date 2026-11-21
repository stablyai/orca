import { useAppStore } from '@/store'
import { blockRemovalForUnsavedFiles } from '../sidebar/workspace-actions/deletion/removal-unsaved-files'
import type { Worktree } from '../../../../shared/worktree/types'
import type { PerforceCopyDeleteTarget } from './perforce-copy-target'

/** Opens the copy's delete dialog unless the copy has unsaved editor text; returns whether it opened. */
export function requestPerforceCopyDelete(
  worktree: Pick<Worktree, 'id' | 'hostId' | 'displayName'>,
  copy: PerforceCopyDeleteTarget
): boolean {
  // Why: the copy dialog has no unsaved-files consent, so unsaved text must be saved or closed first.
  if (blockRemovalForUnsavedFiles(useAppStore.getState, [worktree], worktree.displayName)) {
    return false
  }
  useAppStore.getState().openModal('delete-perforce-copy', copy)
  return true
}
