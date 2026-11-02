import { useCallback } from 'react'
import { toast } from 'sonner'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import { translate } from '@/i18n/i18n'
import { getConnectionId } from '@/lib/connection-context'
import { commitRuntimeGit, completeRuntimeGitMerge } from '@/runtime/runtime-git-sync-client'
import type { SourceControlOperationTarget } from '../listing/operation-target'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { SourceControlStatusRefresh } from '../sync/use-status-refresh'
import { writeCommitDraftForWorktree } from './commit-drafts'

/** Explicit targets keep Create PR commits on their starting worktree after navigation. */
export function useSourceControlCommitAction({
  activeRepoTarget,
  activeWorktree,
  activeWorktreeId,
  beginGitBranchCompareRequest,
  commitInFlightRef,
  commitMessage,
  compareBaseRef,
  refreshActiveGitStatusAfterMutation,
  refreshBranchCompareRef,
  refreshGitHistoryRef,
  setCommitErrorForWorktree,
  setCommitInFlightByWorktree,
  stagedCount,
  unresolvedConflictCount,
  updateCommitDrafts,
  worktreePath
}: {
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktree: SourceControlWorktreeContext['activeWorktree']
  activeWorktreeId: string | null
  beginGitBranchCompareRequest: SourceControlStoreActions['beginGitBranchCompareRequest']
  commitInFlightRef: SourceControlWorktreeOperationState['commitInFlightRef']
  commitMessage: string
  compareBaseRef: string | null
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
  refreshGitHistoryRef: React.RefObject<() => Promise<void>>
  setCommitErrorForWorktree: SourceControlWorktreeOperationState['setCommitErrorForWorktree']
  setCommitInFlightByWorktree: SourceControlWorktreeOperationState['setCommitInFlightByWorktree']
  stagedCount: number
  unresolvedConflictCount: number
  updateCommitDrafts: SourceControlWorktreeOperationState['updateCommitDrafts']
  worktreePath: string | null
}) {
  const handleCommit = useCallback(
    async (
      messageOverride?: string,
      options?: {
        skipStagedSnapshotCheck?: boolean
        skipActiveConflictCheck?: boolean
        target?: SourceControlOperationTarget
      }
    ): Promise<boolean> => {
      const target =
        options?.target ??
        (activeWorktreeId && worktreePath
          ? {
              target: activeRepoTarget,
              worktreeId: activeWorktreeId,
              worktreePath,
              connectionId: getConnectionId(activeWorktreeId) ?? undefined,
              pushTarget: activeWorktree?.pushTarget
            }
          : null)
      if (!target) {
        return false
      }
      const message = (messageOverride ?? commitMessage).trim()
      if (
        !message ||
        (!options?.skipStagedSnapshotCheck && stagedCount === 0) ||
        (!options?.skipActiveConflictCheck && unresolvedConflictCount > 0)
      ) {
        return false
      }

      if (commitInFlightRef.current[target.worktreeId]) {
        return false
      }
      commitInFlightRef.current[target.worktreeId] = true

      setCommitInFlightByWorktree((prev) => ({ ...prev, [target.worktreeId]: true }))
      setCommitErrorForWorktree(target.worktreeId, null)
      try {
        const commitResult = await commitRuntimeGit(
          {
            // Route commits through workspace ownership rather than focused runtime.
            target: requireGitOwnerTarget(target.target),
            worktreeId: target.worktreeId,
            worktreePath: target.worktreePath,
            connectionId: target.connectionId
          },
          message
        )
        if (!commitResult.success) {
          setCommitErrorForWorktree(target.worktreeId, commitResult.error ?? 'Commit failed')
          return false
        }

        // Clear only an unchanged submitted draft so typing during commit cannot lose new edits.
        updateCommitDrafts((prev) => {
          const current = prev[target.worktreeId]
          if (current !== undefined && current.trim() !== message) {
            return prev
          }
          return writeCommitDraftForWorktree(prev, target.worktreeId, '')
        })
        setCommitErrorForWorktree(target.worktreeId, null)
        if (!options?.target) {
          void refreshActiveGitStatusAfterMutation()
        }
        // Set compare loading immediately so No changes cannot flash before the post-commit comparison arrives.
        if (!options?.target && compareBaseRef) {
          beginGitBranchCompareRequest(
            target.worktreeId,
            `${target.worktreeId}:${compareBaseRef}:${Date.now()}:post-commit`,
            compareBaseRef
          )
        }
        if (!options?.target) {
          void refreshBranchCompareRef.current()
          void refreshGitHistoryRef.current()
        }
        return true
      } catch (error) {
        setCommitErrorForWorktree(
          target.worktreeId,
          error instanceof Error ? error.message : 'Commit failed'
        )
        return false
      } finally {
        setCommitInFlightByWorktree((prev) => ({ ...prev, [target.worktreeId]: false }))
        commitInFlightRef.current[target.worktreeId] = false
      }
    },
    [
      activeRepoTarget,
      activeWorktree?.pushTarget,
      activeWorktreeId,
      beginGitBranchCompareRequest,
      commitInFlightRef,
      commitMessage,
      compareBaseRef,
      refreshActiveGitStatusAfterMutation,
      refreshBranchCompareRef,
      refreshGitHistoryRef,
      setCommitErrorForWorktree,
      setCommitInFlightByWorktree,
      stagedCount,
      updateCommitDrafts,
      unresolvedConflictCount,
      worktreePath
    ]
  )

  const handleCompleteMerge = useCallback(async (): Promise<void> => {
    if (!activeWorktreeId || !worktreePath || unresolvedConflictCount > 0) {
      return
    }
    if (commitInFlightRef.current[activeWorktreeId]) {
      return
    }
    commitInFlightRef.current[activeWorktreeId] = true
    setCommitInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: true }))
    let result: { success: boolean; error?: string }
    try {
      result = await completeRuntimeGitMerge({
        target: requireGitOwnerTarget(activeRepoTarget),
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId: getConnectionId(activeWorktreeId) ?? undefined
      })
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : undefined }
    } finally {
      setCommitInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: false }))
      commitInFlightRef.current[activeWorktreeId] = false
    }
    void refreshActiveGitStatusAfterMutation()
    if (!result.success) {
      // The commit area and its inline error stay hidden while the merge is paused.
      toast.error(
        translate(
          'auto.components.right.sidebar.source.control.commit.completeMergeFailed',
          'Complete merge failed'
        ),
        { description: result.error }
      )
      return
    }
    if (compareBaseRef) {
      beginGitBranchCompareRequest(
        activeWorktreeId,
        `${activeWorktreeId}:${compareBaseRef}:${Date.now()}:post-commit`,
        compareBaseRef
      )
    }
    void refreshBranchCompareRef.current()
    void refreshGitHistoryRef.current()
  }, [
    activeRepoTarget,
    activeWorktreeId,
    beginGitBranchCompareRequest,
    commitInFlightRef,
    compareBaseRef,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    setCommitInFlightByWorktree,
    unresolvedConflictCount,
    worktreePath
  ])

  return { handleCommit, handleCompleteMerge }
}

export type SourceControlCommitAction = ReturnType<typeof useSourceControlCommitAction>
