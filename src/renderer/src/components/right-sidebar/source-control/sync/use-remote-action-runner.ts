import { useCallback } from 'react'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import { isSyncPushStageError } from '@/lib/source-control/remote/source-control-remote-error'
import { shouldForcePushWithLeaseForUpstream } from '../../../../../../shared/git/remotes/git-upstream-status'
import {
  captureSourceControlRecoveryEntrySnapshot,
  type SourceControlActionError,
  type SourceControlRecoveryStatusEntry
} from './action-error'
import type { SourceControlCommitAction } from '../commit/use-commit-action'
import type { SourceControlOperationTarget } from '../listing/operation-target'
import type { SourceControlFileListing } from '../listing/use-file-listing'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlWorktreeOperationState } from '../panel/use-worktree-operation-state'
import { refreshSourceControlAfterRemoteAction, resolveRemoteActionError } from './remote-refresh'
import type { SourceControlStatusRefresh } from './use-status-refresh'

export type SourceControlRemoteActionKind =
  | 'push'
  | 'force_push'
  | 'pull'
  | 'fast_forward'
  | 'sync'
  | 'fetch'
  | 'publish'
  | 'rebase'

// Distinguish failures from supersession/no-ops so Create PR cannot treat supersession as destructive failure.
export type RunRemoteActionResult =
  | { status: 'ok' }
  | { status: 'failed'; error: SourceControlActionError }
  | { status: 'superseded' }
  | { status: 'skipped' }

/** Store slices own failure toasts; swallow remote-action errors here. */
export function useSourceControlRemoteActionRunner({
  activeRepoTarget,
  activeWorktree,
  activeWorktreeId,
  branchName,
  effectiveBaseRef,
  fastForwardBranch,
  fetchBranch,
  grouped,
  handleCommit,
  operationStore,
  pullBranch,
  pushBranch,
  rebaseFromBase,
  refreshActiveGitStatusAfterMutation,
  refreshBranchCompareRef,
  refreshGitHistoryRef,
  remoteStatus,
  remoteStatusForActions,
  syncBranch,
  worktreePath
}: {
  activeRepoTarget: SourceControlWorktreeContext['activeRepoTarget']
  activeWorktree: SourceControlWorktreeContext['activeWorktree']
  activeWorktreeId: string | null
  branchName: string
  effectiveBaseRef: string | null
  fastForwardBranch: SourceControlStoreActions['fastForwardBranch']
  fetchBranch: SourceControlStoreActions['fetchBranch']
  grouped: SourceControlFileListing['grouped']
  handleCommit: SourceControlCommitAction['handleCommit']
  operationStore: SourceControlWorktreeOperationState['operationStore']
  pullBranch: SourceControlStoreActions['pullBranch']
  pushBranch: SourceControlStoreActions['pushBranch']
  rebaseFromBase: SourceControlStoreActions['rebaseFromBase']
  refreshActiveGitStatusAfterMutation: SourceControlStatusRefresh['refreshActiveGitStatusAfterMutation']
  refreshBranchCompareRef: React.RefObject<() => Promise<void>>
  refreshGitHistoryRef: React.RefObject<() => Promise<void>>
  remoteStatus: SourceControlWorktreeContext['remoteStatus']
  remoteStatusForActions: SourceControlWorktreeContext['remoteStatus']
  syncBranch: SourceControlStoreActions['syncBranch']
  worktreePath: string | null
}) {
  const scope = useSourceControlScope()
  const runRemoteAction = useCallback(
    async (
      kind: SourceControlRemoteActionKind,
      options?: {
        target?: SourceControlOperationTarget
        baseRef?: string | null
      }
    ): Promise<RunRemoteActionResult> => {
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
        return { status: 'skipped' }
      }
      const sequence = operationStore.getState().remoteActionSequence + 1
      operationStore.setState({ remoteActionSequence: sequence, remoteActionError: null })
      const targetIsActiveWorktree = target.worktreeId === activeWorktreeId
      const recoveryEntrySnapshot = captureSourceControlRecoveryEntrySnapshot(
        targetIsActiveWorktree
          ? ([
              ...grouped.staged,
              ...grouped.unstaged,
              ...grouped.untracked
            ] satisfies SourceControlRecoveryStatusEntry[])
          : []
      )
      const failureBranchName = targetIsActiveWorktree ? branchName || null : null
      try {
        if (kind === 'publish') {
          await pushBranch(
            target.worktreeId,
            target.worktreePath,
            true,
            target.connectionId,
            target.pushTarget,
            { runtimeTarget: target.target }
          )
          return { status: 'ok' }
        }
        if (kind === 'push') {
          // Keep Push regular; automatic force escalation would contradict its dropdown tooltip.
          await pushBranch(
            target.worktreeId,
            target.worktreePath,
            false,
            target.connectionId,
            target.pushTarget,
            { runtimeTarget: target.target }
          )
          return { status: 'ok' }
        }
        if (kind === 'force_push') {
          await pushBranch(
            target.worktreeId,
            target.worktreePath,
            false,
            target.connectionId,
            target.pushTarget,
            { forceWithLease: true, runtimeTarget: target.target }
          )
          return { status: 'ok' }
        }
        if (kind === 'pull') {
          await pullBranch(
            target.worktreeId,
            target.worktreePath,
            target.connectionId,
            target.pushTarget,
            {
              runtimeTarget: target.target
            }
          )
          return { status: 'ok' }
        }
        if (kind === 'fast_forward') {
          await fastForwardBranch(
            target.worktreeId,
            target.worktreePath,
            target.connectionId,
            target.pushTarget,
            { runtimeTarget: target.target }
          )
          return { status: 'ok' }
        }
        if (kind === 'fetch') {
          await fetchBranch(
            target.worktreeId,
            target.worktreePath,
            target.connectionId,
            target.pushTarget,
            {
              runtimeTarget: target.target
            }
          )
          return { status: 'ok' }
        }
        if (kind === 'rebase') {
          const baseRef = options?.baseRef ?? effectiveBaseRef
          if (!baseRef) {
            return { status: 'skipped' }
          }
          await rebaseFromBase(
            target.worktreeId,
            target.worktreePath,
            baseRef,
            target.connectionId,
            target.pushTarget,
            { runtimeTarget: target.target }
          )
          return { status: 'ok' }
        }
        await syncBranch(
          target.worktreeId,
          target.worktreePath,
          target.connectionId,
          target.pushTarget,
          {
            runtimeTarget: target.target
          }
        )
        if (operationStore.getState().remoteActionSequence === sequence) {
          operationStore.setState({ remoteActionError: null })
        }
        return { status: 'ok' }
      } catch (error) {
        // Keep failures inline after dropdowns close; store actions already own the toast.
        if (operationStore.getState().remoteActionSequence !== sequence) {
          return { status: 'superseded' }
        }
        const actionError: SourceControlActionError = {
          kind,
          message: resolveRemoteActionError(kind, error),
          rawError: error instanceof Error ? error.message : String(error),
          syncPushStage: kind === 'sync' ? isSyncPushStageError(error) : false,
          branchName: failureBranchName,
          worktreePath: target.worktreePath,
          entriesSnapshot: recoveryEntrySnapshot.entries,
          entriesSnapshotTotalCount: recoveryEntrySnapshot.totalCount,
          sequence
        }
        operationStore.setState({ remoteActionError: actionError })
        return { status: 'failed', error: actionError }
      } finally {
        if (!options?.target) {
          refreshSourceControlAfterRemoteAction({
            worktreeId: target.worktreeId,
            refreshGitStatus: refreshActiveGitStatusAfterMutation,
            refreshBranchCompare: refreshBranchCompareRef.current,
            refreshGitHistory: refreshGitHistoryRef.current
          })
        }
      }
    },
    [
      scope,
      activeRepoTarget,
      activeWorktree?.pushTarget,
      activeWorktreeId,
      branchName,
      fetchBranch,
      fastForwardBranch,
      effectiveBaseRef,
      grouped.staged,
      grouped.unstaged,
      grouped.untracked,
      operationStore,
      pullBranch,
      pushBranch,
      rebaseFromBase,
      refreshActiveGitStatusAfterMutation,
      refreshBranchCompareRef,
      refreshGitHistoryRef,
      syncBranch,
      worktreePath
    ]
  )

  // Run remote follow-ups only after commit succeeds.
  const runCompoundCommitAction = useCallback(
    async (remoteKind: 'push' | 'sync'): Promise<void> => {
      const ok = await handleCommit()
      if (!ok) {
        return
      }
      // Commit & Force Push retains remoteKind push; select the explicit lease-force path.
      if (
        remoteKind === 'push' &&
        shouldForcePushWithLeaseForUpstream(remoteStatusForActions ?? remoteStatus)
      ) {
        await runRemoteAction('force_push')
        return
      }
      await runRemoteAction(remoteKind)
    },
    [handleCommit, remoteStatus, remoteStatusForActions, runRemoteAction]
  )

  return { runCompoundCommitAction, runRemoteAction }
}

export type SourceControlRemoteActionRunner = ReturnType<typeof useSourceControlRemoteActionRunner>
