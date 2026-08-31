import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import { prepareActiveWorktreeFocusAfterDelete } from './active-worktree-focus-after-delete'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'
import { settleForceDeleteRetry } from './force-delete-retry-toast'
import { showDeleteWorktreeErrorToast } from './show-delete-worktree-error-toast'
import type { WorktreeDeleteWithToastOptions } from './worktree-delete-request'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'

// A failed delete usually means unresolved changes, so land on the diff panel.
function viewWorktreeDiff(
  worktreeId: string,
  executionHostId: WorktreeRemovalTarget['executionHostId']
): void {
  // The Source Control panel is the requested surface — don't re-seed a shell in a
  // workspace the user is trying to delete.
  activateAndRevealWorktree(worktreeId, {
    providesInitialSurface: true,
    ...(executionHostId ? { executionHostId } : {})
  })
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
          void settleForceDeleteRetry(forceRemoval, {
            worktreeName,
            onViewChanges: () => viewWorktreeDiff(worktreeId, target.executionHostId),
            onDeleted: () => {
              commitForceFocus()
              options.onForceDeleted?.(target)
            }
          })
        },
        worktreeId,
        worktreeName
      })
      return false
    })
    .catch((err: unknown) => {
      showDeleteWorktreeErrorToast({ error: err, kind: 'delete', worktreeName })
      return false
    })
}
