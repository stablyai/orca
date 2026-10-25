import { useCallback } from 'react'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { getConnectionId } from '@/lib/connection-context'
import { abortRuntimeGitMerge, abortRuntimeGitRebase } from '@/runtime/runtime-git-sync-client'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'
import type { AbortConflictOperation } from '../listing/operation-target'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import { refreshSourceControlAfterRemoteAction } from './remote-refresh'
import type { SourceControlStatusRefresh } from './use-status-refresh'

export function useSourceControlConflictAbort({
  activeRepoTarget,
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
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
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

  const handleAbortOperation = useCallback(
    async (requestedOperation: AbortConflictOperation): Promise<void> => {
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
      const title = isRebase
        ? translate('sourceControl.abort.rebaseTitle', 'Abort rebase?')
        : translate('sourceControl.abort.mergeTitle', 'Abort merge?')
      const description = isRebase
        ? translate(
            'sourceControl.abort.rebaseDescription',
            'This cancels the rebase in progress and can discard conflict resolutions made during this rebase.'
          )
        : translate(
            'sourceControl.abort.mergeDescription',
            'This cancels the merge in progress and can discard conflict resolutions made during this merge.'
          )
      const confirmed = await confirmAction({
        title,
        description,
        confirmLabel: isRebase
          ? translate('sourceControl.abort.rebaseConfirm', 'Abort rebase')
          : translate('sourceControl.abort.mergeConfirm', 'Abort merge'),
        confirmVariant: 'destructive'
      })
      if (!confirmed) {
        return
      }

      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      setAbortOperationInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: true }))
      setRemoteActionErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
      try {
        const context = {
          // Abort on the repo owner, which may differ from the focused host.
          target: requireGitOwnerTarget(activeRepoTarget),
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        }
        const abortGitOperation = isRebase ? abortRuntimeGitRebase : abortRuntimeGitMerge
        await abortGitOperation(context)
      } catch (error) {
        const failure = isRebase
          ? translate('sourceControl.abort.rebaseFailed', 'Failed to abort rebase')
          : translate('sourceControl.abort.mergeFailed', 'Failed to abort merge')
        const message = error instanceof Error ? error.message : failure
        toast.error(failure, { description: message })
        setRemoteActionErrors((prev) => ({
          ...prev,
          [activeWorktreeId]: {
            kind: isRebase ? 'abort_rebase' : 'abort_merge',
            message,
            rawError: error instanceof Error ? error.message : `Failed to abort ${label}`
          }
        }))
      } finally {
        setAbortOperationInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: false }))
        refreshSourceControlAfterRemoteAction({
          refreshGitStatus: refreshActiveGitStatusAfterMutation,
          refreshBranchCompare: refreshBranchCompareRef.current,
          refreshGitHistory: refreshGitHistoryRef.current
        })
      }
    },
    [
      activeRepoTarget,
      activeWorktreeId,
      confirmAction,
      conflictOperation,
      isAbortingOperation,
      refreshActiveGitStatusAfterMutation,
      refreshBranchCompareRef,
      refreshGitHistoryRef,
      setAbortOperationInFlightByWorktree,
      setRemoteActionErrors,
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
