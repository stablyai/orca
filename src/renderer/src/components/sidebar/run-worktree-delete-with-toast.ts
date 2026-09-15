import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import { prepareActiveWorktreeFocusAfterDelete } from './active-worktree-focus-after-delete'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'
import type { WorktreeDeleteWithToastOptions } from './worktree-delete-request'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'
import { registerWorkspaceSurfaceProducer } from '@/lib/workspace-surface-production'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

// A failed delete usually means unresolved changes, so land on the diff panel.
function viewWorktreeDiff(
  worktreeId: string,
  executionHostId: WorktreeRemovalTarget['executionHostId']
): void {
  const state = useAppStore.getState()
  const producer = registerWorkspaceSurfaceProducer({
    workspaceKey: worktreeId,
    executionHostId: executionHostId ?? getExecutionHostIdForWorktree(state, worktreeId)
  })
  try {
    const activation = activateAndRevealWorktree(
      worktreeId,
      executionHostId ? { executionHostId } : {}
    )
    if (activation === false) {
      producer.failed('The workspace is no longer available.')
      return
    }
    state.setRightSidebarTab('source-control')
    state.setRightSidebarOpen(true)
    producer.materialized({ kind: 'workspace-content', id: 'source-control' })
  } catch (error) {
    producer.failed(error)
  }
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
  const showFailureToast = (
    error: string,
    state: ReturnType<typeof getDeleteStateForWorktreeHost>
  ): void => {
    const hasKnownChanges =
      (useAppStore.getState().gitStatusByWorktree[worktreeId]?.length ?? 0) > 0
    showDeleteWorktreeFailureToast({
      error,
      canForceDelete: state?.canForceDelete ?? false,
      canWaiveArchiveHook: state?.canWaiveArchiveHook === true,
      forceDeleteReason: state?.forceDeleteReason ?? null,
      lockReason: state?.lockReason ?? null,
      hasKnownChanges,
      onViewChanges: () => viewWorktreeDiff(worktreeId, target.executionHostId),
      // Why (#19334): re-runs the archive hook and waives the failure this time, so the waiver
      // is an informed choice made after reading the refusal -- not something `force` implied.
      onDeleteAnyway: () =>
        retryFromToast({ force: options.force === true, allowFailedArchiveHook: true }),
      // The explicit Force Delete retry may waive an unverified PTY-stop proof.
      onForceDelete: () =>
        retryFromToast({
          force: true,
          allowUnverifiedPtyStop: true,
          failedTitle: translate(
            'auto.components.sidebar.delete.worktree.flow.4f3876c0f5',
            'Force delete failed'
          ),
          withViewAction: true
        }),
      worktreeId,
      worktreeName
    })
  }

  // Both toast buttons do the same thing: recapture focus (the user may have navigated while the
  // toast was open), retry with one waiver added, and report a success through `onForceDeleted` so
  // the caller's bookkeeping runs. Only the waiver and the failure copy differ.
  const retryFromToast = (retry: {
    force: boolean
    allowUnverifiedPtyStop?: boolean
    allowFailedArchiveHook?: boolean
    failedTitle?: string
    withViewAction?: boolean
  }): void => {
    const commitRetryFocus = prepareActiveWorktreeFocusAfterDelete(worktreeId)
    const viewAction = retry.withViewAction
      ? {
          action: {
            label: translate('auto.components.sidebar.delete.worktree.flow.7488ed8711', 'View'),
            onClick: () => viewWorktreeDiff(worktreeId, target.executionHostId)
          }
        }
      : {}
    // Why re-show the full failure toast rather than a bare `toast.error` (#19334): a retry can
    // fail for a DIFFERENT reason than the one the user just answered. Waiving a failed archive
    // hook on a dirty checkout lands on the dirty preflight next, and a bare error offers no
    // buttons — leaving the user stuck one step further in, which is the dead end this gate has
    // now produced three times. Routing back through the same toast keeps every retry actionable.
    const failed = (description: string): void => {
      const retryState = getDeleteStateForWorktreeHost(
        { id: worktreeId, hostId: target.executionHostId ?? undefined },
        useAppStore.getState().deleteStateByWorktreeId
      )
      if (retryState?.canForceDelete === true || retryState?.canWaiveArchiveHook === true) {
        showFailureToast(description, retryState)
        return
      }
      toast.error(
        retry.failedTitle ??
          translate(
            'auto.components.sidebar.delete.worktree.flow.ae57cbf6e4',
            'Failed to delete workspace'
          ),
        { description, ...viewAction }
      )
    }
    useAppStore
      .getState()
      .removeWorktree(target, retry.force, {
        ...(retry.allowUnverifiedPtyStop ? { allowUnverifiedPtyStop: true } : {}),
        ...(retry.allowFailedArchiveHook ? { allowFailedArchiveHook: true } : {})
      })
      .then((result) => {
        if (!result.ok) {
          failed(result.error)
          return
        }
        commitRetryFocus()
        // "A retry started from this toast completed the delete" — callers hang their bookkeeping
        // off it, so without this a batch or Space-panel delete keeps listing what it removed.
        options.onForceDeleted?.(target)
      })
      .catch((err: unknown) => failed(err instanceof Error ? err.message : String(err)))
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
      showFailureToast(
        result.error,
        getDeleteStateForWorktreeHost(
          { id: worktreeId, hostId: target.executionHostId ?? undefined },
          useAppStore.getState().deleteStateByWorktreeId
        )
      )
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
