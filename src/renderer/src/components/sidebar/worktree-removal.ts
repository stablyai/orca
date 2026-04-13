import type { Worktree } from '../../../../shared/types'
import type { UISlice } from '@/store/slices/ui'

type OpenModal = (modal: UISlice['activeModal'], data?: Record<string, unknown>) => void
type ClearWorktreeDeleteState = (worktreeId: string) => void

export type WorktreeRemovalAction = {
  disabled: boolean
  disabledReason?: string
  label: string
}

export function getWorktreeRemovalAction(
  worktree: Pick<Worktree, 'id' | 'repoId' | 'displayName' | 'isMainWorktree'>,
  isFolder: boolean
): WorktreeRemovalAction {
  if (isFolder) {
    return {
      disabled: false,
      label: 'Remove folder from Orca'
    }
  }

  if (worktree.isMainWorktree) {
    return {
      disabled: true,
      disabledReason: 'The main worktree cannot be deleted',
      label: 'Delete worktree'
    }
  }

  return {
    disabled: false,
    label: 'Delete worktree'
  }
}

export function openWorktreeRemovalModal(
  worktree: Pick<Worktree, 'id' | 'repoId' | 'displayName' | 'isMainWorktree'>,
  isFolder: boolean,
  openModal: OpenModal,
  clearWorktreeDeleteState: ClearWorktreeDeleteState
): void {
  if (!isFolder && worktree.isMainWorktree) {
    // Why: the shared helper is the boundary between row-level affordances and
    // the destructive modal flow. Guarding the main-worktree invariant here
    // keeps future callers from reintroducing a modal path Git can never honor.
    return
  }

  if (isFolder) {
    // Why: folder mode reuses the worktree row UI for a synthetic root entry,
    // but removal there only disconnects Orca from that folder. Reusing the
    // git delete dialog would imply filesystem deletion semantics we do not do.
    openModal('confirm-remove-folder', {
      repoId: worktree.repoId,
      displayName: worktree.displayName
    })
    return
  }

  // Why: both the context menu and the new hover button lead into the same
  // confirmation dialog. Clearing stale delete state here ensures either entry
  // point starts with a clean dialog instead of re-showing an old error.
  clearWorktreeDeleteState(worktree.id)
  openModal('delete-worktree', { worktreeId: worktree.id })
}
