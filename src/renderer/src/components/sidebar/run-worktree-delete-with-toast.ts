import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import { prepareActiveWorktreeFocusAfterDelete } from './active-worktree-focus-after-delete'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'
import type { WorktreeDeleteWithToastOptions } from './worktree-delete-request'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'

// A failed delete usually means unresolved changes, so land on the diff panel.
function viewWorktreeDiff(
  worktreeId: string,
  executionHostId: WorktreeRemovalTarget['executionHostId']
): void {
  activateAndRevealWorktree(worktreeId, executionHostId ? { executionHostId } : {})
  const state = useAppStore.getState()
  state.setRightSidebarTab('source-control')
  state.setRightSidebarOpen(true)
}

export function runWorktreeDeleteWithToast(
  target: WorktreeRemovalTarget,
  worktreeName: string,
  options: WorktreeDeleteWithToastOptions = {}
): Promise<boolean> {
  const worktreeId = target.id
  const removeWorktree = useAppStore.getState().removeWorktree
  const commitFocus = prepareActiveWorktreeFocusAfterDelete(worktreeId)
  const focusSuccessor = options.focusSuccessorOnDelete !== false

  const removeOptions = {
    ...(options.suppressPreservedBranchToast ? { suppressPreservedBranchToast: true } : {}),
    ...(options.snapshotPruneBatchId ? { snapshotPruneBatchId: options.snapshotPruneBatchId } : {})
  }
  const removal =
    Object.keys(removeOptions).length > 0
      ? removeWorktree(target, options.force === true, removeOptions)
      : removeWorktree(target, options.force === true)
  return removal
    .then((result) => {
      if (result.ok) {
        if (result.preservedBranch) {
          options.onPreservedBranch?.({
            worktreeId,
            branchName: result.preservedBranch.branchName,
            expectedHead: result.preservedBranch.head,
            ...(result.preservedBranch.hostId ? { hostId: result.preservedBranch.hostId } : {}),
            ...(result.preservedBranch.runtimeEnvironmentId
              ? { runtimeEnvironmentId: result.preservedBranch.runtimeEnvironmentId }
              : {})
          })
        }
        if (focusSuccessor) {
          commitFocus()
        }
        return true
      }
      const state = getDeleteStateForWorktreeHost(
        { id: worktreeId, hostId: target.executionHostId ?? undefined },
        useAppStore.getState().deleteStateByWorktreeId
      )
      const canForceDelete = state?.canForceDelete ?? false
      const hasKnownChanges =
        (useAppStore.getState().gitStatusByWorktree[worktreeId]?.length ?? 0) > 0
      showDeleteWorktreeFailureToast({
        error: result.error,
        canForceDelete,
        forceDeleteReason: state?.forceDeleteReason ?? null,
        lockReason: state?.lockReason ?? null,
        hasKnownChanges,
        onViewChanges: () => viewWorktreeDiff(worktreeId, target.executionHostId),
        onForceDelete: () => {
          // Recapture focus because the user may have navigated while the toast was open.
          const commitForceFocus = prepareActiveWorktreeFocusAfterDelete(worktreeId)
          // The explicit Force Delete retry may waive an unverified PTY-stop proof.
          const forceRemoval = useAppStore
            .getState()
            .removeWorktree(target, true, { allowUnverifiedPtyStop: true })
          forceRemoval
            .then((forceResult) => {
              if (!forceResult.ok) {
                toast.error(
                  translate(
                    'auto.components.sidebar.delete.worktree.flow.4f3876c0f5',
                    'Force delete failed'
                  ),
                  {
                    description: forceResult.error,
                    action: {
                      label: translate(
                        'auto.components.sidebar.delete.worktree.flow.7488ed8711',
                        'View'
                      ),
                      onClick: () => viewWorktreeDiff(worktreeId, target.executionHostId)
                    }
                  }
                )
                return
              }
              commitForceFocus()
              options.onForceDeleted?.(target)
            })
            .catch((err: unknown) => {
              toast.error(
                translate(
                  'auto.components.sidebar.delete.worktree.flow.ae57cbf6e4',
                  'Failed to delete workspace'
                ),
                {
                  description: err instanceof Error ? err.message : String(err),
                  action: {
                    label: translate(
                      'auto.components.sidebar.delete.worktree.flow.7488ed8711',
                      'View'
                    ),
                    onClick: () => viewWorktreeDiff(worktreeId, target.executionHostId)
                  }
                }
              )
            })
        },
        worktreeId,
        worktreeName
      })
      return false
    })
    .catch((err: unknown) => {
      toast.error(
        translate(
          'auto.components.sidebar.delete.worktree.flow.ae57cbf6e4',
          'Failed to delete workspace'
        ),
        { description: err instanceof Error ? err.message : String(err) }
      )
      return false
    })
}
