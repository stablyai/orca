import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { continueRuntimeGitSequencer } from '@/runtime/runtime-git-client'
import { isGitSequencerOperation } from '../../../../../../shared/git-sequencer-step'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import { useSourceControlConflictOperationRunner } from './use-conflict-operation-runner'
import type { SourceControlStatusRefresh } from './use-status-refresh'

/** Continue for an in-progress merge/rebase/cherry-pick: moves the sequencer forward. */
export function useSourceControlConflictAdvance({
  activeRepoSettings,
  activeWorktreeId,
  conflictOperation,
  isAdvancingOperation,
  isAbortingOperation,
  refreshActiveGitStatusAfterMutation,
  refreshBranchCompareRef,
  refreshGitHistoryRef,
  setAdvanceOperationInFlightByWorktree,
  setRemoteActionErrors,
  worktreePath
}: {
  activeRepoSettings: SourceControlWorktreeContext['activeRepoSettings']
  activeWorktreeId: string | null
  conflictOperation: GitConflictOperation
  isAdvancingOperation: boolean
  isAbortingOperation: boolean
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
  refreshGitHistoryRef: React.RefObject<() => Promise<void>>
  setAdvanceOperationInFlightByWorktree: SourceControlWorktreeOperationState['setAdvanceOperationInFlightByWorktree']
  setRemoteActionErrors: SourceControlWorktreeOperationState['setRemoteActionErrors']
  worktreePath: string | null
}) {
  const runConflictOperation = useSourceControlConflictOperationRunner({
    activeRepoSettings,
    activeWorktreeId,
    conflictOperation,
    isBlocked: isAdvancingOperation || isAbortingOperation,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    setInFlightByWorktree: setAdvanceOperationInFlightByWorktree,
    setRemoteActionErrors,
    worktreePath
  })

  const handleContinueOperation = useCallback(
    (operation: GitConflictOperation): void => {
      if (!isGitSequencerOperation(operation)) {
        return
      }
      void runConflictOperation({
        requestedOperation: operation,
        errorKind: 'continue_operation',
        failureToast: translate(
          'auto.components.right.sidebar.source.control.sync.use.conflict.advance.b84fcd7ea6',
          'Continue {{value0}} failed',
          { value0: operation }
        ),
        run: (context) => continueRuntimeGitSequencer(context, operation)
      })
    },
    [runConflictOperation]
  )

  return { handleContinueOperation }
}

export type SourceControlConflictAdvance = ReturnType<typeof useSourceControlConflictAdvance>
