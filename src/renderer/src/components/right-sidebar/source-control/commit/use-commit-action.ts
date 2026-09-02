import { useCallback } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { commitRuntimeGit } from '@/runtime/runtime-git-client'
import type { SourceControlOperationTarget } from '../listing/operation-target'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { SourceControlStatusRefresh } from '../sync/use-status-refresh'
import { writeCommitDraftForWorktree } from './commit-drafts'

/**
 * Commits the staged snapshot for a target worktree. Accepts an explicit target so a Create PR run
 * can keep committing to the worktree it started on after the user navigates away.
 */
export function useSourceControlCommitAction({
  activeRepoSettings,
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
  activeRepoSettings: SourceControlWorktreeContext['activeRepoSettings']
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
              settings: activeRepoSettings,
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
            // Why: route the commit by the repo OWNER host, not the focused runtime.
            settings: target.settings,
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

        // Why: textarea stays editable during commit, so only clear the draft when it still matches what we committed — else we'd discard edits typed after Commit.
        updateCommitDrafts((prev) => {
          const current = prev[target.worktreeId]
          if (current !== undefined && current.trim() !== message) {
            // User typed more after submit — preserve their in-progress edits.
            return prev
          }
          return writeCommitDraftForWorktree(prev, target.worktreeId, '')
        })
        setCommitErrorForWorktree(target.worktreeId, null)
        if (!options?.target) {
          void refreshActiveGitStatusAfterMutation()
        }
        // Why: flip branchSummary to 'loading' synchronously so "No changes on this branch" doesn't flash before the branchCompare poll lands the commit.
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
      activeRepoSettings,
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

  return { handleCommit }
}

export type SourceControlCommitAction = ReturnType<typeof useSourceControlCommitAction>
