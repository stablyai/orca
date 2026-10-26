import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  toWorktreeRemovalTarget,
  type WorktreeRemovalTarget
} from '../../../../shared/worktree/removal'
import type { RemoveWorktreeOptions } from '@/store/slices/worktree-removal-options'
import type { RendererRemoveWorktreeResult } from '@/store/slices/renderer-remove-worktree-result'
import { showWorkspaceListChangedToast } from './stale-workspace-list-toast'
import type { ConfirmedUnsavedDiscards } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'

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
  confirmedDiscards: ConfirmedUnsavedDiscards
}): void {
  const { worktreeId, currentWorktrees, removeWorktree, closeModal, onDeleted } = args
  // Use the confirmed row’s host so same-path checkouts on other hosts cannot be force-deleted.
  const forceTarget = currentWorktrees.find((entry) => entry.id === worktreeId)
  if (!forceTarget) {
    // Stale confirmations must explain changed targets and close rather than leave a silent destructive button.
    showWorkspaceListChangedToast()
    closeModal()
    return
  }
  // Explicit Force Delete may waive PTY-stop proof, unlike ordinary confirmed deletion.
  const deletePromise = removeWorktree(toWorktreeRemovalTarget(forceTarget), true, {
    allowUnverifiedPtyStop: true,
    confirmedDiscards: args.confirmedDiscards
  })
  closeModal()
  deletePromise
    .then((result) => {
      if (!result.ok) {
        toast.error(
          translate(
            'auto.components.sidebar.DeleteWorktreeDialog.42e610d6cf',
            'Force delete failed'
          ),
          {
            description: result.error
          }
        )
        return
      }
      onDeleted?.([toWorktreeRemovalTarget(forceTarget)])
    })
    .catch((err: unknown) => {
      toast.error(
        translate(
          'auto.components.sidebar.DeleteWorktreeDialog.4f6750ca7b',
          'Failed to delete workspace'
        ),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
    })
}
