import type { Worktree } from '../../../../shared/worktree/types'
import {
  toWorktreeRemovalTarget,
  type WorktreeRemovalTarget
} from '../../../../shared/worktree/removal'
import type { RemoveWorktreeOptions } from '@/store/slices/worktree-removal-options'
import type { RendererRemoveWorktreeResult } from '@/store/slices/renderer-remove-worktree-result'
import { prepareActiveWorktreeFocusAfterDelete } from './active-worktree-focus-after-delete'
import { showWorkspaceListChangedToast } from './stale-workspace-list-toast'
import { settleForceDeleteRetry } from './force-delete-retry-toast'

/**
 * The dialog's explicit "Force Delete" retry.
 *
 * Runs the destructive retry itself rather than through `runWorktreeDeleteWithToast`,
 * preserving the legacy button behaviour, and closes immediately because the workspace
 * cards already show the deleting state. Its failures still report through the shared
 * copy funnel (STA-4895).
 */
export function runDialogForceDelete(args: {
  worktreeId: string
  currentWorktrees: readonly Worktree[]
  removeWorktree: (
    target: WorktreeRemovalTarget,
    force?: boolean,
    options?: RemoveWorktreeOptions
  ) => Promise<({ ok: true } & RendererRemoveWorktreeResult) | { ok: false; error: string }>
  closeModal: () => void
  onDeleted: ((deleted: WorktreeRemovalTarget[]) => void) | null | undefined
}): void {
  const { worktreeId, currentWorktrees, removeWorktree, closeModal, onDeleted } = args
  // Why: this branch preserves the legacy "Force Delete" button behavior inside the
  // dialog. Close immediately because workspace cards already show the deleting state.
  // Why the lookup (STA-4343): the confirmed row carries the host the
  // removal must land on; a bare id would let force delete another host's
  // checkout at the same path.
  const forceTarget = currentWorktrees.find((entry) => entry.id === worktreeId)
  if (!forceTarget) {
    // Same recovery as a stale confirmed batch: say so and close, rather
    // than leaving a destructive button that silently does nothing.
    showWorkspaceListChangedToast()
    closeModal()
    return
  }
  const commitFocus = prepareActiveWorktreeFocusAfterDelete(worktreeId)
  // Why (#11960): this IS the explicit Force Delete, so it may also waive
  // the PTY-stop proof — unlike the confirmed delete in the branch below.
  const deletePromise = removeWorktree(toWorktreeRemovalTarget(forceTarget), true, {
    allowUnverifiedPtyStop: true
  })
  closeModal()
  void settleForceDeleteRetry(deletePromise, {
    worktreeName: forceTarget.displayName,
    onDeleted: () => {
      commitFocus()
      onDeleted?.([toWorktreeRemovalTarget(forceTarget)])
    }
  })
}
