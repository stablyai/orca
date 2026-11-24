import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import type {
  RebaseStopInspectFailure,
  WorktreeOperationStore
} from '../panel/worktree-operation-store'
import { refreshSourceControlAfterRemoteAction } from './remote-refresh'
import type { SourceControlStatusRefresh } from './use-status-refresh'
import { requireGitOwnerTarget } from './worktree-git-owner-target'
import { resolveRebaseContinueState } from '../panel/base-rebase-state'
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
  inspectFailure,
  indexObservation,
  worktreePath
}: {
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktreeId: string | null
  conflictOperation: GitConflictOperation
  operationStore: WorktreeOperationStore
  // The paused rebase has no reading for the current HEAD yet.
  rebaseStopUnread: boolean
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
  refreshGitHistoryRef: React.RefObject<() => Promise<void>>
  // The HEAD status reports; a move while still unread starts a fresh inspection.
  statusHead: string | null
  inspectFailure: RebaseStopInspectFailure | null
  indexObservation: string | null
  worktreePath: string | null
}) {
  const scope = useSourceControlScope()
  const [retry, setRetry] = useState<{ store: WorktreeOperationStore; sequence: number } | null>(
    null
  )
  const retryOwner = useRef<{ store: WorktreeOperationStore; sequence: number } | null>(null)
  const inspectAttempt = useRef(0)
  const latest = useRef({
    operationStore,
    activeWorktreeId,
    worktreePath,
    activeRepoTarget,
    conflictOperation,
    statusHead,
    indexObservation
  })
  useLayoutEffect(() => {
    latest.current = {
      operationStore,
      activeWorktreeId,
      worktreePath,
      activeRepoTarget,
      conflictOperation,
      statusHead,
      indexObservation
    }
  }, [
    operationStore,
    activeWorktreeId,
    worktreePath,
    activeRepoTarget,
    conflictOperation,
    statusHead,
    indexObservation
  ])
  const failureCurrent =
    inspectFailure &&
    inspectFailure.head === statusHead &&
    (inspectFailure.indexObservation === undefined ||
      inspectFailure.indexObservation === indexObservation)
  const retryCurrent = retry?.store === operationStore
  const shouldInspect =
    conflictOperation === 'rebase' && !failureCurrent && (rebaseStopUnread || retryCurrent)
  useEffect(() => {
    if (!shouldInspect || !activeRepoTarget || !activeWorktreeId || !worktreePath) {
      return
    }
    let current = true
    const attempt = ++inspectAttempt.current
    const priorStop = operationStore.getState().rebaseStop
    void inspectRebaseStop(
      {
        target: requireGitOwnerTarget(activeRepoTarget),
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId: sourceControlConnectionId(scope, activeWorktreeId)
      },
      operationStore,
      statusHead,
      indexObservation,
      priorStop?.blocked === 'empty' ? priorStop : null,
      () => current
    ).finally(() => {
      if (inspectAttempt.current === attempt && retryOwner.current?.store === operationStore) {
        retryOwner.current = null
        setRetry(null)
      }
    })
    return () => {
      current = false
    }
  }, [
    activeRepoTarget,
    activeWorktreeId,
    operationStore,
    scope,
    shouldInspect,
    statusHead,
    indexObservation,
    worktreePath,
    retry?.sequence
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
      latest.current.operationStore !== operationStore ||
      latest.current.activeWorktreeId !== activeWorktreeId ||
      latest.current.activeRepoTarget !== activeRepoTarget ||
      latest.current.worktreePath !== worktreePath ||
      resolveRebaseContinueState(
        state.rebaseStop,
        latest.current.statusHead,
        state.rebaseStopInspectFailure,
        latest.current.indexObservation
      ) !== 'ready' ||
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
  const handleRetryRebaseInspect = useCallback((): void => {
    const current = latest.current
    if (
      current.operationStore !== operationStore ||
      current.activeWorktreeId !== activeWorktreeId ||
      current.activeRepoTarget !== activeRepoTarget ||
      current.worktreePath !== worktreePath ||
      !current.activeRepoTarget ||
      !current.activeWorktreeId ||
      !current.worktreePath ||
      current.conflictOperation !== 'rebase' ||
      retryOwner.current?.store === operationStore
    ) {
      return
    }
    const state = operationStore.getState()
    if (
      resolveRebaseContinueState(
        state.rebaseStop,
        current.statusHead,
        state.rebaseStopInspectFailure,
        current.indexObservation
      ) !== 'unreadable'
    ) {
      return
    }
    const request = { store: operationStore, sequence: ++inspectAttempt.current }
    retryOwner.current = request
    setRetry(request)
    operationStore.setState({ rebaseStopInspectFailure: null })
  }, [operationStore, activeWorktreeId, activeRepoTarget, worktreePath])
  return {
    handleContinueRebase,
    handleRetryRebaseInspect,
    isRetryingRebaseInspect: retryCurrent && shouldInspect && !!activeRepoTarget
  }
}

export type SourceControlRebaseContinue = ReturnType<typeof useSourceControlRebaseContinue>
