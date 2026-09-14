import { useCallback, useEffect } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import type { CreatePrIntentRunToken } from './create-pr-intent-flow'
import type { SourceControlOperationTarget } from '../listing/operation-target'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'

/**
 * Tracks what the user is currently looking at so an in-flight Create PR run can tell whether the
 * panel has since moved on, and pins each of the run's git calls to the host it started from.
 */
export function useSourceControlCreatePrIntentTarget({
  activeRepoId,
  activeRepoSettings,
  activeWorktreeId,
  branchName,
  createPrIntentCurrentTargetRef,
  effectiveBaseRef,
  worktreeMap,
  worktreePath
}: {
  activeRepoId: string | null
  activeRepoSettings: SourceControlWorktreeContext['activeRepoSettings']
  activeWorktreeId: string | null
  branchName: string
  createPrIntentCurrentTargetRef: SourceControlWorktreeOperationState['createPrIntentCurrentTargetRef']
  effectiveBaseRef: string | null
  worktreeMap: SourceControlWorktreeContext['worktreeMap']
  worktreePath: string | null
}) {
  useEffect(() => {
    createPrIntentCurrentTargetRef.current = {
      repoId: activeRepoId ?? null,
      worktreeId: activeWorktreeId ?? null,
      worktreePath,
      branch: branchName,
      baseRef: effectiveBaseRef ?? null
    }
  }, [
    activeRepoId,
    activeWorktreeId,
    branchName,
    createPrIntentCurrentTargetRef,
    effectiveBaseRef,
    worktreePath
  ])

  const getCreatePrIntentOperationTarget = useCallback(
    (token: CreatePrIntentRunToken): SourceControlOperationTarget => ({
      // Why: Create PR intent continues after navigation; pin git commands to the worktree/host that started the sequence.
      settings: activeRepoSettings,
      worktreeId: token.worktreeId,
      worktreePath: token.worktreePath,
      connectionId: getConnectionId(token.worktreeId) ?? undefined,
      pushTarget: worktreeMap.get(token.worktreeId)?.pushTarget
    }),
    [activeRepoSettings, worktreeMap]
  )

  return { getCreatePrIntentOperationTarget }
}

export type SourceControlCreatePrIntentTarget = ReturnType<
  typeof useSourceControlCreatePrIntentTarget
>
