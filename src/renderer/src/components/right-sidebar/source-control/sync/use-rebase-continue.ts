import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import type { RebaseStopInspectFailure, RebaseStopReading } from '../panel/worktree-operation-store'
import { refreshSourceControlAfterRemoteAction } from './remote-refresh'
import type { SourceControlStatusRefresh } from './use-status-refresh'
import { requireGitOwnerTarget } from './worktree-git-owner-target'
import { inspectRebaseStop, runContinueRequest } from './rebase-step-request'

export function useSourceControlRebaseContinue({
  activeRepoTarget,
  activeWorktreeId,
  conflictOperation,
  operationStore,
  rebaseStopUnread,
  refreshActiveGitStatusAfterMutation,
  refreshBranchCompareRef,
  refreshGitHistoryRef,
  statusHead,
  rebaseStop,
  inspectFailure,
  indexObservation,
  worktreePath
}: {
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktreeId: string | null
  conflictOperation: GitConflictOperation
  operationStore: OperationStore
  // The paused rebase has no reading for the current HEAD yet.
  rebaseStopUnread: boolean
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
  refreshGitHistoryRef: React.RefObject<() => Promise<void>>
  // The HEAD status reports; a move while still unread starts a fresh inspection.
  statusHead: string | null
  rebaseStop: RebaseStopReading | null
  inspectFailure: RebaseStopInspectFailure | null
  indexObservation: string | null
  worktreePath: string | null
}) {
  const scope = useSourceControlScope()
  const [isRetryingRebaseInspect, setIsRetryingRebaseInspect] = useState(false)
  const inspectAttempt = useRef(0)
  const emptyObservation =
    rebaseStop?.blocked === 'empty' &&
    indexObservation &&
    rebaseStop.indexObservation &&
    indexObservation !== rebaseStop.indexObservation
      ? indexObservation
      : null
  const shouldInspect =
    conflictOperation === 'rebase' &&
    !(inspectFailure && inspectFailure.head === statusHead) &&
    (rebaseStopUnread || !!emptyObservation)
  useEffect(() => {
    // An unresolved owner has no host to ask; requireGitOwnerTarget below would throw out of the effect.
    if (!shouldInspect || !activeRepoTarget || !activeWorktreeId || !worktreePath) {
      return
    }
    let current = true
    const attempt = ++inspectAttempt.current
    void inspectRebaseStop(
      {
        target: requireGitOwnerTarget(activeRepoTarget),
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId: sourceControlConnectionId(scope, activeWorktreeId)
      },
      operationStore,
      statusHead,
      emptyObservation,
      emptyObservation ? rebaseStop : null,
      () => current
    ).finally(() => {
      if (inspectAttempt.current === attempt) {
        setIsRetryingRebaseInspect(false)
      }
    })
    return () => {
      current = false
    }
  }, [
    activeRepoTarget,
    activeWorktreeId,
    emptyObservation,
    operationStore,
    rebaseStop,
    scope,
    shouldInspect,
    statusHead,
    worktreePath
  ])

  // Continue only the complete stop that was shown.
  const runRebaseStep = useCallback(async (): Promise<void> => {
    const state = operationStore.getState()
    // Admit only with a resolved owner: requireGitOwnerTarget runs after the lock is taken, outside
    // runContinueRequest's finally, so a throw there would leave Continue and Abort locked.
    if (
      !activeRepoTarget ||
      !activeWorktreeId ||
      !worktreePath ||
      conflictOperation !== 'rebase' ||
      state.isAbortingOperation ||
      !state.rebaseStop ||
      state.rebaseStop.blocked !== null ||
      !state.rebaseStop.token.head ||
      !state.rebaseStop.token.step ||
      !state.rebaseStop.token.incarnation
    ) {
      return
    }
    // isAbortingOperation is the shared conflict-operation lock that Abort and the busy gates read.
    operationStore.setState({
      isAbortingOperation: true,
      isContinuingRebase: true,
      remoteActionError: null
    })
    await runContinueRequest({
      context: {
        target: requireGitOwnerTarget(activeRepoTarget),
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId: sourceControlConnectionId(scope, activeWorktreeId)
      },
      operationStore,
      refresh: () =>
        refreshSourceControlAfterRemoteAction({
          worktreeId: activeWorktreeId,
          refreshGitStatus: refreshActiveGitStatusAfterMutation,
          refreshBranchCompare: refreshBranchCompareRef.current,
          refreshGitHistory: refreshGitHistoryRef.current
        })
    })
  }, [
    scope,
    activeRepoTarget,
    activeWorktreeId,
    conflictOperation,
    operationStore,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    worktreePath
  ])
  const handleContinueRebase = runRebaseStep
  // Clearing the failure makes the stop unread again, which re-runs the inspect effect above.
  const handleRetryRebaseInspect = useCallback((): void => {
    inspectAttempt.current++
    setIsRetryingRebaseInspect(true)
    operationStore.setState({
      ...(operationStore.getState().rebaseStop?.blocked === 'empty' ? {} : { rebaseStop: null }),
      rebaseStopInspectFailure: null
    })
  }, [operationStore])
  return {
    handleContinueRebase,
    handleRetryRebaseInspect,
    isRetryingRebaseInspect: isRetryingRebaseInspect && shouldInspect && !!activeRepoTarget
  }
}

export type SourceControlRebaseContinue = ReturnType<typeof useSourceControlRebaseContinue>
