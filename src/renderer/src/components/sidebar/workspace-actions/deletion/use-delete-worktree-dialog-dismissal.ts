import { useCallback, useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'

export function useDeleteWorktreeDialogDismissal({
  isOpen,
  isDeleting,
  isSaving,
  isBatchDelete,
  worktreeId,
  worktreeCount,
  deleteStateTargets,
  clearWorktreeDeleteState,
  closeModal
}: {
  isOpen: boolean
  isDeleting: boolean
  isSaving: boolean
  isBatchDelete: boolean
  worktreeId: string
  worktreeCount: number
  deleteStateTargets: readonly Pick<Worktree, 'id' | 'hostId'>[]
  clearWorktreeDeleteState: AppState['clearWorktreeDeleteState']
  closeModal: () => void
}) {
  useEffect(() => {
    if (isOpen && deleteStateTargets.length > 0 && worktreeCount === 0 && !isDeleting) {
      for (const target of deleteStateTargets) {
        clearWorktreeDeleteState(target.id, target.hostId)
      }
      closeModal()
    }
  }, [clearWorktreeDeleteState, closeModal, deleteStateTargets, isDeleting, isOpen, worktreeCount])

  return useCallback(
    (open: boolean) => {
      if (open || isSaving) {
        return
      }
      const state = useAppStore.getState().deleteStateByWorktreeId
      const currentTarget = deleteStateTargets.find((target) => target.id === worktreeId)
      const currentState = currentTarget
        ? getDeleteStateForWorktreeHost(currentTarget, state)
        : undefined
      if (isBatchDelete) {
        for (const target of deleteStateTargets) {
          if (!getDeleteStateForWorktreeHost(target, state)?.isDeleting) {
            clearWorktreeDeleteState(target.id, target.hostId)
          }
        }
      } else if (worktreeId && !currentState?.isDeleting) {
        clearWorktreeDeleteState(worktreeId, currentTarget?.hostId)
      }
      closeModal()
    },
    [clearWorktreeDeleteState, closeModal, deleteStateTargets, isBatchDelete, isSaving, worktreeId]
  )
}
