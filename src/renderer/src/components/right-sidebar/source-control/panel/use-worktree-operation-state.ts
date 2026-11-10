import {
  useSourceControlState,
  useSourceControlStoreView,
  useSourceControlScope
} from './worktree-scope'
import { useCallback, useEffect } from 'react'
import { useStore } from 'zustand'
import { worktreeGitCopyHostId } from '@/lib/worktree-git-copy'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'
import { remoteActionErrorSettledByConflictOperation } from '../sync/remote-refresh'
import {
  clearLandedBranchSwitchError,
  getWorktreeOperationStore,
  writeWorktreeCommitDraft
} from './worktree-operation-store'

/** Bind the panel to its owner's operation record; admission reads `operationStore.getState()`. */
export function useSourceControlWorktreeOperationState({
  activeWorktreeId,
  activeWorktreeInstanceId,
  conflictOperation
}: {
  activeWorktreeId: string | null
  activeWorktreeInstanceId: string | undefined
  conflictOperation: GitConflictOperation
}) {
  const scope = useSourceControlScope()
  // A folder section names its host; only the active panel falls back to the selected copy.
  const selectedHostId = useSourceControlState((s) =>
    !scope && activeWorktreeId ? worktreeGitCopyHostId(s, activeWorktreeId) : null
  )
  const operationStore = getWorktreeOperationStore(
    activeWorktreeId,
    scope ? scope.executionHostId : selectedHostId,
    activeWorktreeInstanceId
  )
  const operationView = useSourceControlStoreView(operationStore)
  const commitMessage = useStore(operationView, (s) => s.draft)
  const commitError = useStore(operationView, (s) => s.commitError)
  const isCommitting = useStore(operationView, (s) => s.isCommitting)
  const isAbortingOperation = useStore(operationView, (s) => s.isAbortingOperation)
  const remoteActionError = useStore(operationView, (s) => s.remoteActionError)
  const activeRemoteActionSequence = useStore(operationView, (s) =>
    s.remoteActionSequence > 0 ? s.remoteActionSequence : null
  )
  const isCreatingPr = useStore(operationView, (s) => s.isCreatingPr)
  const isCreatePrIntentInFlight = useStore(operationView, (s) => s.createPrIntentRun !== null)
  const createPrIntentNotice = useStore(operationView, (s) => s.createPrIntentNotice)

  const updateCommitDraft = useCallback(
    (update: string | ((draft: string) => string)): void =>
      writeWorktreeCommitDraft(operationStore, update),
    [operationStore]
  )
  const recordBranchSwitchOutcome = useCallback(
    (refresh?: () => Promise<void>): void => {
      clearLandedBranchSwitchError(operationStore)
      void refresh?.().catch(() => {})
    },
    [operationStore]
  )

  useEffect(() => {
    // Terminal conflict resolution must clear stale failure banners once status observes the operation ending.
    const { observedConflictOperation, remoteActionError } = operationStore.getState()
    operationStore.setState({
      observedConflictOperation: conflictOperation,
      ...(remoteActionError &&
      remoteActionErrorSettledByConflictOperation(
        remoteActionError,
        observedConflictOperation,
        conflictOperation
      )
        ? { remoteActionError: null }
        : {})
    })
  }, [conflictOperation, operationStore])

  return {
    activeRemoteActionSequence,
    commitError,
    commitMessage,
    createPrIntentNotice,
    isAbortingOperation,
    isCommitting,
    isCreatePrIntentInFlight,
    isCreatingPr,
    operationStore,
    recordBranchSwitchOutcome,
    remoteActionError,
    updateCommitDraft
  }
}

export type SourceControlWorktreeOperationState = ReturnType<
  typeof useSourceControlWorktreeOperationState
>
