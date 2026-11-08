import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { worktreeCopyPushTarget } from '@/lib/worktree-git-copy'
import type { CreatePrIntentRunToken } from './create-pr-intent-flow'
import type { SourceControlOperationTarget } from '../listing/operation-target'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'

/** Track foreground ownership and pin in-flight Git calls to their original host. */
export function useSourceControlCreatePrIntentTarget({
  activeRepoId,
  activeWorktreeId,
  branchName,
  effectiveBaseRef,
  operationStore,
  worktreePath
}: {
  activeRepoId: string | null
  activeWorktreeId: string | null
  branchName: string
  effectiveBaseRef: string | null
  operationStore: SourceControlWorktreeOperationState['operationStore']
  worktreePath: string | null
}) {
  const previousOperationStoreRef = useRef(operationStore)
  useEffect(() => {
    // Navigating to another owner backgrounds the previous run; unmounting alone does not.
    if (previousOperationStoreRef.current !== operationStore) {
      previousOperationStoreRef.current.setState({ createPrIntentTarget: {} })
      previousOperationStoreRef.current = operationStore
    }
    operationStore.setState({
      createPrIntentTarget: {
        repoId: activeRepoId ?? null,
        worktreeId: activeWorktreeId ?? null,
        worktreePath,
        branch: branchName,
        baseRef: effectiveBaseRef ?? null
      }
    })
  }, [activeRepoId, activeWorktreeId, branchName, effectiveBaseRef, operationStore, worktreePath])

  const getCreatePrIntentOperationTarget = useCallback(
    (token: CreatePrIntentRunToken): SourceControlOperationTarget =>
      createPrIntentOperationTarget(
        token,
        // Why the pinned copy's row: a same-path twin's push target names another remote and branch.
        worktreeCopyPushTarget(
          useAppStore.getState(),
          token.worktreeId,
          token.pinnedCopy?.hostId ?? null
        )
      ),
    []
  )

  return { getCreatePrIntentOperationTarget }
}

/**
 * Pins a Create PR run's calls to the copy and transport captured when it started, never
 * re-resolved: a copy that did not resolve gets no transport, so the run refuses instead of
 * committing or pushing on a same-path twin's checkout.
 */
export function createPrIntentOperationTarget(
  token: CreatePrIntentRunToken,
  pushTarget: SourceControlOperationTarget['pushTarget']
): SourceControlOperationTarget {
  const copy = token.pinnedCopy
  return {
    worktreeId: token.worktreeId,
    worktreePath: token.worktreePath,
    pushTarget,
    target: copy?.transport ?? null,
    connectionId: copy?.connectionId,
    ownerHostId: copy?.hostId ?? null
  }
}

export type SourceControlCreatePrIntentTarget = ReturnType<
  typeof useSourceControlCreatePrIntentTarget
>
