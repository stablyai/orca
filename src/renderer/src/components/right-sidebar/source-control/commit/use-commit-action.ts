import { GIT_GRAPH_REFRESH_EVENT } from '@/lib/git-graph-tab'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { requireGitOwnerTarget } from '../sync/worktree-git-owner-target'
import { translate } from '@/i18n/i18n'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import {
  commitRuntimeGit,
  completeRuntimeGitMerge
} from '@/runtime/source-control/git/runtime-git-sync-client'
import type { SourceControlOperationTarget } from '../listing/operation-target'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { SourceControlStatusRefresh } from '../sync/use-status-refresh'

/** Explicit targets keep Create PR commits on their starting worktree after navigation. */
export function useSourceControlCommitAction({
  activeRepoTarget,
  activeWorktree,
  activeWorktreeId,
  beginGitBranchCompareRequest,
  commitMessage,
  compareBaseRef,
  operationStore,
  refreshActiveGitStatusAfterMutation,
  refreshBranchCompareRef,
  refreshGitHistoryRef,
  stagedCount,
  unresolvedConflictCount,
  updateCommitDraft,
  worktreePath
}: {
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktree: SourceControlWorktreeContext['activeWorktree']
  activeWorktreeId: string | null
  beginGitBranchCompareRequest: SourceControlStoreActions['beginGitBranchCompareRequest']
  commitMessage: string
  compareBaseRef: string | null
  operationStore: SourceControlWorktreeOperationState['operationStore']
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
  refreshGitHistoryRef: React.RefObject<() => Promise<void>>
  stagedCount: number
  unresolvedConflictCount: number
  updateCommitDraft: SourceControlWorktreeOperationState['updateCommitDraft']
  worktreePath: string | null
}) {
  const scope = useSourceControlScope()
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
              connectionId: sourceControlConnectionId(scope, activeWorktreeId),
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

      // Admission reads the owner record synchronously so a double-click or remount cannot resubmit.
      if (operationStore.getState().isCommitting) {
        return false
      }
      operationStore.setState({ isCommitting: true, commitError: null })
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
          operationStore.setState({ commitError: commitResult.error ?? 'Commit failed' })
          return false
        }

        // Clear only an unchanged submitted draft so typing during commit cannot lose new edits.
        updateCommitDraft((current) => (current.trim() !== message ? current : ''))
        operationStore.setState({ commitError: null })
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
          window.dispatchEvent(
            new CustomEvent(GIT_GRAPH_REFRESH_EVENT, { detail: target.worktreeId })
          )
          void refreshGitHistoryRef.current()
        }
        return true
      } catch (error) {
        operationStore.setState({
          commitError: error instanceof Error ? error.message : 'Commit failed'
        })
        return false
      } finally {
        operationStore.setState({ isCommitting: false })
      }
    },
    [
      scope,
      activeRepoTarget,
      activeWorktree?.pushTarget,
      activeWorktreeId,
      beginGitBranchCompareRequest,
      commitMessage,
      compareBaseRef,
      operationStore,
      refreshActiveGitStatusAfterMutation,
      refreshBranchCompareRef,
      refreshGitHistoryRef,
      stagedCount,
      updateCommitDraft,
      unresolvedConflictCount,
      worktreePath
    ]
  )

  const handleCompleteMerge = useCallback(async (): Promise<void> => {
    if (!activeWorktreeId || !worktreePath || unresolvedConflictCount > 0) {
      return
    }
    if (operationStore.getState().isCommitting) {
      return
    }
    operationStore.setState({ isCommitting: true })
    let result: { success: boolean; error?: string }
    try {
      result = await completeRuntimeGitMerge({
        target: requireGitOwnerTarget(activeRepoTarget),
        worktreeId: activeWorktreeId,
        worktreePath,
        connectionId: sourceControlConnectionId(scope, activeWorktreeId)
      })
    } catch (error) {
      result = { success: false, error: error instanceof Error ? error.message : undefined }
    } finally {
      operationStore.setState({ isCommitting: false })
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
    window.dispatchEvent(new CustomEvent(GIT_GRAPH_REFRESH_EVENT, { detail: activeWorktreeId }))
    void refreshGitHistoryRef.current()
  }, [
    activeRepoTarget,
    activeWorktreeId,
    beginGitBranchCompareRequest,
    compareBaseRef,
    operationStore,
    refreshActiveGitStatusAfterMutation,
    refreshBranchCompareRef,
    refreshGitHistoryRef,
    scope,
    unresolvedConflictCount,
    worktreePath
  ])

  return { handleCommit, handleCompleteMerge }
}

export type SourceControlCommitAction = ReturnType<typeof useSourceControlCommitAction>
