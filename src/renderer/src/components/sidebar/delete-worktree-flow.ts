import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'

/**
 * Shared delete-with-toast flow used by both DeleteWorktreeDialog (confirm
 * path) and WorktreeContextMenu (skip-confirm path). Centralizes the error
 * toast copy, the "Force Delete" action wiring, and the "View" affordance so
 * both entry points behave identically from the user's perspective.
 *
 * Why this is a module helper rather than a store action: the behavior is
 * intrinsically UI-shaped — it shows sonner toasts, registers action/cancel
 * handlers, and depends on `activateAndRevealWorktree` (a renderer-only
 * helper). Keeping it in the renderer layer avoids bleeding toast/UI
 * concerns into the store slice while still preventing the two delete
 * entry points from drifting apart.
 */
export function runWorktreeDeleteWithToast(worktreeId: string, worktreeName: string): void {
  const removeWorktree = useAppStore.getState().removeWorktree

  removeWorktree(worktreeId, false)
    .then((result) => {
      if (result.ok) {
        return
      }
      const state = useAppStore.getState().deleteStateByWorktreeId[worktreeId]
      const canForceDelete = state?.canForceDelete ?? false
      const toastCopy = getDeleteWorktreeToastCopy(worktreeName, canForceDelete, result.error)
      const showToast = toastCopy.isDestructive ? toast.error : toast.info
      showToast(toastCopy.title, {
        description: toastCopy.description,
        duration: 10000,
        cancel: {
          label: 'View',
          onClick: () => activateAndRevealWorktree(worktreeId)
        },
        action: canForceDelete
          ? {
              label: 'Force Delete',
              onClick: () => {
                useAppStore
                  .getState()
                  .removeWorktree(worktreeId, true)
                  .then((forceResult) => {
                    if (!forceResult.ok) {
                      toast.error('Force delete failed', {
                        description: forceResult.error,
                        action: {
                          label: 'View',
                          onClick: () => activateAndRevealWorktree(worktreeId)
                        }
                      })
                    }
                  })
                  .catch((err: unknown) => {
                    toast.error('Failed to delete worktree', {
                      description: err instanceof Error ? err.message : String(err),
                      action: {
                        label: 'View',
                        onClick: () => activateAndRevealWorktree(worktreeId)
                      }
                    })
                  })
              }
            }
          : undefined
      })
    })
    .catch((err: unknown) => {
      toast.error('Failed to delete worktree', {
        description: err instanceof Error ? err.message : String(err)
      })
    })
}
