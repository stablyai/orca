import { useCallback } from 'react'
import { requireGitOwnerTarget } from './worktree-git-owner-target'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import {
  abortRuntimeGitMerge,
  abortRuntimeGitRebase
} from '@/runtime/source-control/git/runtime-git-sync-client'
import type {
  GitAbortOperationRequest,
  GitConflictOperation
} from '../../../../../../shared/git/status/git-status-types'
import type { AbortConflictOperation } from '../listing/operation-target'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import { refreshSourceControlAfterRemoteAction } from './remote-refresh'
import { extractIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { toastIfOperationRunChanged } from './operation-run-changed-toast'
import type { SourceControlStatusRefresh } from './use-status-refresh'
import { runWithFinally } from '@/lib/run-with-finally'

/** `confirmed`: the caller already confirmed in place, so skip the dialog. `expectedRunIdentity`:
 *  the run that confirmation was for; the abort refuses if a different run is paused now. */
type ConflictAbortOptions = { confirmed?: boolean } & GitAbortOperationRequest

export function useSourceControlConflictAbort({
  activeRepoTarget,
  activeWorktreeId,
  conflictOperation,
  operationStore,
  refreshActiveGitStatusAfterMutation,
  refreshBranchCompareRef,
  refreshGitHistoryRef,
  worktreePath
}: {
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktreeId: string | null
  conflictOperation: GitConflictOperation
  operationStore: SourceControlWorktreeOperationState['operationStore']
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
  refreshGitHistoryRef: React.RefObject<() => Promise<void>>
  worktreePath: string | null
}) {
  const scope = useSourceControlScope()
  const confirmAction = useConfirmationDialog()

  const handleAbortOperation = useCallback(
    async (
      requestedOperation: AbortConflictOperation,
      // The operation bar confirms in place, so it skips the dialog.
      { confirmed = false, expectedRunIdentity }: ConflictAbortOptions = {}
    ): Promise<void> => {
      if (
        !activeWorktreeId ||
        !worktreePath ||
        conflictOperation !== requestedOperation ||
        operationStore.getState().isAbortingOperation
      ) {
        return
      }

      const isRebase = requestedOperation === 'rebase'
      const title = isRebase
        ? translate(
            'auto.components.right.sidebar.SourceControl.abortRebaseConfirmTitle',
            'Abort rebase?'
          )
        : translate(
            'auto.components.right.sidebar.SourceControl.abortMergeConfirmTitle',
            'Abort merge?'
          )
      const description = isRebase
        ? translate(
            'auto.components.right.sidebar.SourceControl.abortRebaseConfirmDescription',
            'This cancels the rebase in progress and can discard conflict resolutions made during this rebase.'
          )
        : translate(
            'auto.components.right.sidebar.SourceControl.abortMergeConfirmDescription',
            'This cancels the merge in progress and can discard conflict resolutions made during this merge.'
          )
      const approved =
        confirmed ||
        (await confirmAction({
          title,
          description,
          confirmLabel: isRebase
            ? translate('auto.components.right.sidebar.SourceControl.425f138269', 'Abort rebase')
            : translate('auto.components.right.sidebar.SourceControl.540ca8f78c', 'Abort merge'),
          confirmVariant: 'destructive'
        }))
      if (!approved || operationStore.getState().isAbortingOperation) {
        return
      }

      const connectionId = sourceControlConnectionId(scope, activeWorktreeId)
      operationStore.setState({ isAbortingOperation: true, remoteActionError: null })
      await runWithFinally(
        async () => {
          try {
            const context = {
              // Abort on the repo owner, which may differ from the focused host.
              target: requireGitOwnerTarget(activeRepoTarget),
              worktreeId: activeWorktreeId,
              worktreePath,
              connectionId
            }
            const abortGitOperation = isRebase ? abortRuntimeGitRebase : abortRuntimeGitMerge
            await abortGitOperation(context, { expectedRunIdentity })
          } catch (error) {
            // A refused abort left the new run alone; it is not a failed action to record.
            if (toastIfOperationRunChanged(error)) {
              return
            }
            const message = extractIpcErrorMessage(
              error,
              isRebase
                ? translate(
                    'auto.components.right.sidebar.SourceControl.abortRebaseFailedFallback',
                    'Failed to abort rebase'
                  )
                : translate(
                    'auto.components.right.sidebar.SourceControl.abortMergeFailedFallback',
                    'Failed to abort merge'
                  )
            )
            toast.error(
              isRebase
                ? translate(
                    'auto.components.right.sidebar.SourceControl.abortRebaseFailed',
                    'Abort rebase failed'
                  )
                : translate(
                    'auto.components.right.sidebar.SourceControl.abortMergeFailed',
                    'Abort merge failed'
                  ),
              { description: message }
            )
            operationStore.setState({
              remoteActionError: {
                kind: isRebase ? 'abort_rebase' : 'abort_merge',
                message,
                rawError: message
              }
            })
          }
        },
        () => {
          operationStore.setState({ isAbortingOperation: false })
          refreshSourceControlAfterRemoteAction({
            worktreeId: activeWorktreeId,
            refreshGitStatus: refreshActiveGitStatusAfterMutation,
            refreshBranchCompare: refreshBranchCompareRef.current,
            refreshGitHistory: refreshGitHistoryRef.current
          })
        }
      )
    },
    [
      scope,
      activeRepoTarget,
      activeWorktreeId,
      confirmAction,
      conflictOperation,
      operationStore,
      refreshActiveGitStatusAfterMutation,
      refreshBranchCompareRef,
      refreshGitHistoryRef,
      worktreePath
    ]
  )

  const handleAbortMerge = useCallback(
    async (options?: ConflictAbortOptions): Promise<void> => {
      await handleAbortOperation('merge', options)
    },
    [handleAbortOperation]
  )

  const handleAbortRebase = useCallback(
    async (options?: ConflictAbortOptions): Promise<void> => {
      await handleAbortOperation('rebase', options)
    },
    [handleAbortOperation]
  )

  return {
    confirmAction,
    handleAbortMerge,
    handleAbortOperation,
    handleAbortRebase
  }
}

export type SourceControlConflictAbort = ReturnType<typeof useSourceControlConflictAbort>
