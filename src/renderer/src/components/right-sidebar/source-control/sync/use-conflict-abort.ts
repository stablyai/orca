import { useCallback } from 'react'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { abortRuntimeGitMerge, abortRuntimeGitRebase } from '@/runtime/runtime-git-client'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'
import type { AbortConflictOperation } from '../listing/operation-target'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import { useSourceControlConflictOperationRunner } from './use-conflict-operation-runner'
import type { SourceControlStatusRefresh } from './use-status-refresh'

/**
 * Aborts an in-progress merge or rebase behind a destructive confirmation.
 */
export function useSourceControlConflictAbort({
  activeRepoSettings,
  activeWorktreeId,
  conflictOperation,
  isAbortingOperation,
  refreshActiveGitStatusAfterMutation,
  refreshBranchCompareRef,
  refreshGitHistoryRef,
  setAbortOperationInFlightByWorktree,
  setRemoteActionErrors,
  worktreePath
}: {
  activeRepoSettings: SourceControlWorktreeContext['activeRepoSettings']
  activeWorktreeId: string | null
  conflictOperation: GitConflictOperation
  isAbortingOperation: boolean
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
  refreshGitHistoryRef: React.RefObject<() => Promise<void>>
  setAbortOperationInFlightByWorktree: SourceControlWorktreeOperationState['setAbortOperationInFlightByWorktree']
  setRemoteActionErrors: SourceControlWorktreeOperationState['setRemoteActionErrors']
  worktreePath: string | null
}) {
  const confirmAction = useConfirmationDialog()
  const runConflictOperation = useSourceControlConflictOperationRunner({
    activeRepoSettings,
    activeWorktreeId,
    conflictOperation,
    isBlocked: isAbortingOperation,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    setInFlightByWorktree: setAbortOperationInFlightByWorktree,
    setRemoteActionErrors,
    worktreePath
  })

  const handleAbortOperation = useCallback(
    async (requestedOperation: AbortConflictOperation): Promise<void> => {
      // Why: re-checked by the runner, but guarded here too so a mismatched or
      // already-running operation never even shows the confirmation dialog.
      if (
        !activeWorktreeId ||
        !worktreePath ||
        conflictOperation !== requestedOperation ||
        isAbortingOperation
      ) {
        return
      }

      const isRebase = requestedOperation === 'rebase'
      const label = isRebase ? 'rebase' : 'merge'
      const title = isRebase ? 'Abort rebase?' : 'Abort merge?'
      const description = isRebase
        ? 'This cancels the rebase in progress and can discard conflict resolutions made during this rebase.'
        : 'This cancels the merge in progress and can discard conflict resolutions made during this merge.'
      const confirmed = await confirmAction({
        title,
        description,
        confirmLabel: `Abort ${label}`,
        confirmVariant: 'destructive'
      })
      if (!confirmed) {
        return
      }

      await runConflictOperation({
        requestedOperation,
        errorKind: isRebase ? 'abort_rebase' : 'abort_merge',
        failureToast: translate(
          'auto.components.right.sidebar.SourceControl.f99560ab29',
          'Abort {{value0}} failed',
          { value0: label }
        ),
        fallbackMessage: `Failed to abort ${label}`,
        run: (context) => (isRebase ? abortRuntimeGitRebase : abortRuntimeGitMerge)(context)
      })
    },
    [
      activeWorktreeId,
      confirmAction,
      conflictOperation,
      isAbortingOperation,
      runConflictOperation,
      worktreePath
    ]
  )

  const handleAbortMerge = useCallback(async (): Promise<void> => {
    await handleAbortOperation('merge')
  }, [handleAbortOperation])

  const handleAbortRebase = useCallback(async (): Promise<void> => {
    await handleAbortOperation('rebase')
  }, [handleAbortOperation])

  const handleAbortOperationForConflict = useCallback(
    (operation: GitConflictOperation): void => {
      if (operation === 'merge') {
        void handleAbortMerge()
        return
      }
      if (operation === 'rebase') {
        void handleAbortRebase()
      }
    },
    [handleAbortMerge, handleAbortRebase]
  )

  return {
    confirmAction,
    handleAbortMerge,
    handleAbortOperation,
    handleAbortOperationForConflict,
    handleAbortRebase
  }
}

export type SourceControlConflictAbort = ReturnType<typeof useSourceControlConflictAbort>
