import { useCallback } from 'react'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import type { RemoveWorktreeOptions } from '@/store/slices/worktree-removal-options'
import type { RendererRemoveWorktreeResult } from '@/store/slices/renderer-remove-worktree-result'
import type { WorktreeDeleteIdentity } from './worktree-delete-request'
import { runWorktreeDeletesInParallel } from './delete-worktree-flow'
import { runLineageDeleteAll } from './delete-worktree-lineage-delete-all'
import { runDialogForceDelete } from './delete-worktree-dialog-force-delete'

type UseDeleteWorktreeActionsParams = {
  worktreeId: string
  worktreeIds: string[]
  worktreeDeleteIdentities: readonly WorktreeDeleteIdentity[]
  lineageDeleteIdentities: readonly WorktreeDeleteIdentity[]
  resolveConfirmedTargets: (
    identities: readonly WorktreeDeleteIdentity[],
    expectedCount: number
  ) => Worktree[] | null
  dontAskAgain: boolean
  allowSkipConfirm: boolean
  forceOnConfirm: boolean
  persistDontAskAgainPreference: () => void
  removeWorktree: (
    target: WorktreeRemovalTarget,
    force?: boolean,
    options?: RemoveWorktreeOptions
  ) => Promise<({ ok: true } & RendererRemoveWorktreeResult) | { ok: false; error: string }>
  closeModal: () => void
  onDeleted: ((targets: WorktreeRemovalTarget[]) => void) | null
  handleForceDeletedFromToast: (target: WorktreeRemovalTarget) => void
  lineageDelete: { deleteAllTargets: Worktree[] }
}

export function useDeleteWorktreeActions({
  worktreeId,
  worktreeIds,
  worktreeDeleteIdentities,
  lineageDeleteIdentities,
  resolveConfirmedTargets,
  dontAskAgain,
  allowSkipConfirm,
  forceOnConfirm,
  persistDontAskAgainPreference,
  removeWorktree,
  closeModal,
  onDeleted,
  handleForceDeletedFromToast,
  lineageDelete
}: UseDeleteWorktreeActionsParams) {
  const handleDelete = useCallback(
    (force = false) => {
      if (worktreeIds.length === 0) {
        return
      }
      const currentWorktrees = resolveConfirmedTargets(worktreeDeleteIdentities, worktreeIds.length)
      if (!currentWorktrees) {
        return
      }
      // why: force-delete is a recovery path; don't save skip preference on recovery
      if (dontAskAgain && allowSkipConfirm && !force) {
        persistDontAskAgainPreference()
      }
      if (force) {
        runDialogForceDelete({
          worktreeId,
          currentWorktrees,
          removeWorktree,
          closeModal,
          onDeleted
        })
      } else {
        // why: run parallel deletes on confirm so user feedback stays responsive
        const deletePromise = runWorktreeDeletesInParallel(currentWorktrees, {
          force: forceOnConfirm,
          onForceDeleted: handleForceDeletedFromToast
        })
        closeModal()
        void deletePromise.then((deletedTargets) => {
          if (deletedTargets.length > 0) {
            onDeleted?.(deletedTargets)
          }
        })
      }
    },
    [
      closeModal,
      dontAskAgain,
      allowSkipConfirm,
      handleForceDeletedFromToast,
      forceOnConfirm,
      onDeleted,
      persistDontAskAgainPreference,
      removeWorktree,
      worktreeIds.length,
      worktreeDeleteIdentities,
      worktreeId,
      resolveConfirmedTargets
    ]
  )

  const handleDeleteAll = useCallback(() => {
    runLineageDeleteAll({
      deleteAllTargetCount: lineageDelete.deleteAllTargets.length,
      lineageDeleteIdentities,
      resolveConfirmedTargets,
      forceOnConfirm,
      onForceDeleted: handleForceDeletedFromToast,
      closeModal,
      onDeleted
    })
  }, [
    closeModal,
    handleForceDeletedFromToast,
    forceOnConfirm,
    lineageDelete.deleteAllTargets.length,
    lineageDeleteIdentities,
    onDeleted,
    resolveConfirmedTargets
  ])

  return { handleDelete, handleDeleteAll }
}
