import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import type {
  RebaseStopInspectFailure,
  RebaseStopReading,
  WorktreeOperationStore
} from '../panel/worktree-operation-store'
import { refreshSourceControlAfterRemoteAction } from './remote-refresh'
import type { SourceControlStatusRefresh } from './use-status-refresh'
import { requireGitOwnerTarget } from './worktree-git-owner-target'
import { useAppStore } from '@/store'
import { rebaseStopIndexIsStale } from '../panel/base-rebase-state'
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
  operationStore: WorktreeOperationStore
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
  // Retry belongs to the worktree copy that asked for it; another worktree never shows its progress.
  const [retry, setRetry] = useState<RetryRequest | null>(null)
  // Mirrors retry synchronously so a second press before the busy render is refused.
  const retryRef = useRef<RetryRequest | null>(null)
  const retryAttempts = useRef(0)
  const inspectRun = useRef(0)
  const retryAttempt =
    retry?.store === operationStore && conflictOperation === 'rebase' ? retry.attempt : null
  const indexStale = rebaseStopIndexIsStale(rebaseStop, indexObservation)
  // A step read off the index is re-read against the index status reports now.
  const recheckIndex =
    rebaseStop && (indexStale || (retryAttempt !== null && rebaseStopRestsOnIndex(rebaseStop)))
      ? indexObservation
      : undefined
  const shouldInspect =
    conflictOperation === 'rebase' &&
    (retryAttempt !== null ||
      (!(inspectFailure && inspectFailure.head === statusHead) && (rebaseStopUnread || indexStale)))
  useEffect(() => {
    // An unresolved owner has no host to ask; requireGitOwnerTarget below would throw out of the effect.
    if (!shouldInspect || !activeRepoTarget || !activeWorktreeId || !worktreePath) {
      return
    }
    let current = true
    const run = ++inspectRun.current
    const stop = operationStore.getState().rebaseStop
    const recheck =
      stop && recheckIndex !== undefined && rebaseStopRestsOnIndex(stop)
        ? { stop, observation: recheckIndex }
        : null
    void inspectRebaseStop(
      {
        target: requireGitOwnerTarget(activeRepoTarget),
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId: sourceControlConnectionId(scope, activeWorktreeId)
      },
      operationStore,
      statusHead,
      recheck,
      () => current
    )
      .then((readHead) => {
        // The host is at another HEAD than status shows: refresh status once rather than re-read in a
        // loop. If status still disagrees afterwards, the read counts as failed so Retry is offered.
        if (!current || !readHead || !statusHead || readHead === statusHead) {
          return
        }
        void refreshActiveGitStatusAfterMutation().then(() => {
          const state = operationStore.getState()
          if (
            state.rebaseStop?.token.head === readHead &&
            !state.rebaseStopInspectFailure &&
            readActiveStatusHead(activeWorktreeId) === statusHead
          ) {
            operationStore.setState({
              rebaseStopInspectFailure: { head: statusHead, message: null }
            })
          }
        })
      })
      .finally(() => {
        if (retryAttempt !== null && inspectRun.current === run) {
          if (retryRef.current?.attempt === retryAttempt) {
            retryRef.current = null
          }
          setRetry((value) => (value?.attempt === retryAttempt ? null : value))
        }
      })
    return () => {
      current = false
    }
    // The stop itself is read from the store: each reading publishes a new object, which must not
    // restart this read (a HEAD that disagrees with status would otherwise re-read forever).
  }, [
    activeRepoTarget,
    activeWorktreeId,
    operationStore,
    recheckIndex,
    refreshActiveGitStatusAfterMutation,
    retryAttempt,
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
      !state.rebaseStop.token.incarnation ||
      // Ready only on staged evidence that no longer matches the index.
      rebaseStopIndexIsStale(state.rebaseStop, indexObservation)
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
    indexObservation,
    worktreePath
  ])
  const handleContinueRebase = runRebaseStep
  // Retry always reads the stop again, including an empty step at an unchanged index.
  const handleRetryRebaseInspect = useCallback((): void => {
    const state = operationStore.getState()
    if (
      !activeRepoTarget ||
      !activeWorktreeId ||
      !worktreePath ||
      !state.rebaseStopInspectFailure ||
      retryRef.current?.store === operationStore
    ) {
      return
    }
    const request = { store: operationStore, attempt: ++retryAttempts.current }
    retryRef.current = request
    setRetry(request)
    operationStore.setState({
      // An index-bound step keeps its reading so the retry can confirm it against the index.
      ...(state.rebaseStop && rebaseStopRestsOnIndex(state.rebaseStop) ? {} : { rebaseStop: null }),
      rebaseStopInspectFailure: null
    })
  }, [activeRepoTarget, activeWorktreeId, operationStore, worktreePath])
  return {
    handleContinueRebase,
    handleRetryRebaseInspect,
    isRetryingRebaseInspect: retryAttempt !== null && !!activeRepoTarget
  }
}

type RetryRequest = { store: WorktreeOperationStore; attempt: number }

function rebaseStopRestsOnIndex(stop: RebaseStopReading): boolean {
  return stop.blocked === 'empty' || stop.stagedReady === true
}

function readActiveStatusHead(worktreeId: string): string | null {
  return useAppStore.getState().gitStatusHeadByWorktree?.[worktreeId] ?? null
}

export type SourceControlRebaseContinue = ReturnType<typeof useSourceControlRebaseContinue>
