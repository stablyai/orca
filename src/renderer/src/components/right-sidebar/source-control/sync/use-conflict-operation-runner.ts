import { useCallback } from 'react'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import type { SourceControlActionErrorKind } from './action-error'
import { refreshSourceControlAfterRemoteAction } from './remote-refresh'
import type { SourceControlStatusRefresh } from './use-status-refresh'

export type ConflictOperationRunContext = {
  settings: SourceControlWorktreeContext['activeRepoSettings']
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
}

export type ConflictOperationRunSpec = {
  requestedOperation: GitConflictOperation
  errorKind: SourceControlActionErrorKind
  /** Already-translated toast title for the failure case. */
  failureToast: string
  /** Message when the thrown value is not an Error; defaults to String(error). */
  fallbackMessage?: string
  run: (context: ConflictOperationRunContext) => Promise<void>
}

/**
 * Shared choreography for the conflict banner's mutating actions (Continue, Abort):
 * per-worktree in-flight flag, error record, failure toast, and the post-action
 * status/compare/history refresh. Only the operation-specific work arrives as `run`.
 */
export function useSourceControlConflictOperationRunner({
  activeRepoSettings,
  activeWorktreeId,
  conflictOperation,
  isBlocked,
  refreshActiveGitStatusAfterMutation,
  refreshBranchCompareRef,
  refreshGitHistoryRef,
  setInFlightByWorktree,
  setRemoteActionErrors,
  worktreePath
}: {
  activeRepoSettings: SourceControlWorktreeContext['activeRepoSettings']
  activeWorktreeId: string | null
  conflictOperation: GitConflictOperation
  /** True while another banner action is already running. */
  isBlocked: boolean
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
  refreshGitHistoryRef: React.RefObject<() => Promise<void>>
  setInFlightByWorktree: SourceControlWorktreeOperationState['setAbortOperationInFlightByWorktree']
  setRemoteActionErrors: SourceControlWorktreeOperationState['setRemoteActionErrors']
  worktreePath: string | null
}) {
  return useCallback(
    async (spec: ConflictOperationRunSpec): Promise<void> => {
      if (
        !activeWorktreeId ||
        !worktreePath ||
        conflictOperation !== spec.requestedOperation ||
        isBlocked
      ) {
        return
      }

      const connectionId = getConnectionId(activeWorktreeId) ?? undefined
      setInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: true }))
      setRemoteActionErrors((prev) => ({ ...prev, [activeWorktreeId]: null }))
      try {
        await spec.run({
          // Why: route by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
          worktreeId: activeWorktreeId,
          worktreePath,
          connectionId
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : (spec.fallbackMessage ?? String(error))
        toast.error(spec.failureToast, { description: message })
        setRemoteActionErrors((prev) => ({
          ...prev,
          [activeWorktreeId]: {
            kind: spec.errorKind,
            message,
            rawError: message
          }
        }))
      } finally {
        setInFlightByWorktree((prev) => ({ ...prev, [activeWorktreeId]: false }))
        // Why: the action can land straight in a NEW conflict, so the banner must re-read status.
        refreshSourceControlAfterRemoteAction({
          refreshGitStatus: refreshActiveGitStatusAfterMutation,
          refreshBranchCompare: refreshBranchCompareRef.current,
          refreshGitHistory: refreshGitHistoryRef.current
        })
      }
    },
    [
      activeRepoSettings,
      activeWorktreeId,
      conflictOperation,
      isBlocked,
      refreshActiveGitStatusAfterMutation,
      refreshBranchCompareRef,
      refreshGitHistoryRef,
      setInFlightByWorktree,
      setRemoteActionErrors,
      worktreePath
    ]
  )
}
