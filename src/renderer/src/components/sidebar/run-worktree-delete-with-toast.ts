import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import {
  resolveWorktreeOperationRoute,
  resolveWorktreeOperationRouteForHost
} from '@/lib/worktree-operation-route'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'
import type { WorktreeDeleteWithToastOptions } from './worktree-delete-request'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'
import { blockRemovalForUnsavedFiles } from './removal-unsaved-files'

function viewWorktreeDiff(
  worktreeId: string,
  executionHostId: WorktreeRemovalTarget['executionHostId']
): void {
  // Open Source Control without reseeding a shell in the workspace being deleted.
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

  const removeOptions = {
    ...(options.suppressPreservedBranchToast ? { suppressPreservedBranchToast: true } : {}),
    ...(options.snapshotPruneBatchId ? { snapshotPruneBatchId: options.snapshotPruneBatchId } : {}),
    ...(options.confirmedDiscards ? { confirmedDiscards: options.confirmedDiscards } : {}),
    ...(options.assertBeforeDispatch ? { assertBeforeDispatch: options.assertBeforeDispatch } : {})
  }
  const showFailureToast = (
    error: string,
    state: ReturnType<typeof getDeleteStateForWorktreeHost>
  ): void => {
    const currentState = useAppStore.getState()
    const route = target.executionHostId
      ? resolveWorktreeOperationRouteForHost(currentState, worktreeId, target.executionHostId)
      : resolveWorktreeOperationRoute(currentState, worktreeId)
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
      onAlwaysForceDelete: () =>
        useAppStore.getState().updateSettingsOrThrow({ alwaysForceDeleteWorktrees: true }),
      // Waive archive-hook failure only after explicit refusal review; force alone does not imply consent.
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
      executionHostId: target.executionHostId,
      worktreeName,
      nestedRemovalTarget: route && !route.runtimeEnvironmentId ? target : undefined,
      onNestedDeleted: () => options.onForceDeleted?.(target)
    })
  }

  // Recapture focus and report completion for caller bookkeeping regardless of the waiver chosen.
  const retryFromToast = (retry: {
    force: boolean
    allowUnverifiedPtyStop?: boolean
    allowFailedArchiveHook?: boolean
    failedTitle?: string
    withViewAction?: boolean
  }): void => {
    const viewAction = retry.withViewAction
      ? {
          action: {
            label: translate('auto.components.sidebar.delete.worktree.flow.7488ed8711', 'View'),
            onClick: () => viewWorktreeDiff(worktreeId, target.executionHostId)
          }
        }
      : {}
    // Retries may fail at a different gate; show its actionable toast so another refusal is not a dead end.
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
    // Why: edits made since the first attempt would close unlisted; refuse until saved or closed.
    if (
      blockRemovalForUnsavedFiles(
        useAppStore.getState,
        [{ id: worktreeId, hostId: target.executionHostId ?? undefined }],
        worktreeName
      )
    ) {
      return
    }
    useAppStore
      .getState()
      .removeWorktree(target, retry.force, {
        ...(retry.allowUnverifiedPtyStop ? { allowUnverifiedPtyStop: true } : {}),
        ...(retry.allowFailedArchiveHook ? { allowFailedArchiveHook: true } : {}),
        ...(options.assertBeforeDispatch
          ? { assertBeforeDispatch: options.assertBeforeDispatch }
          : {})
      })
      .then((result) => {
        if (!result.ok) {
          failed(result.error)
          return
        }
        // Notify the caller so batch and Space-panel bookkeeping removes the deleted workspace.
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
