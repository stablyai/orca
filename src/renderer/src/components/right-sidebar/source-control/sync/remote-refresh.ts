import {
  isSyncPushStageError,
  resolveRemoteOperationErrorMessage
} from '@/lib/source-control-remote-error'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'
import type { SourceControlActionError } from './action-error'
import type { RemoteOpKind } from '../../source-control-primary-action'

export function resolveRemoteActionError(kind: RemoteOpKind, error: unknown): string {
  return resolveRemoteOperationErrorMessage(error, {
    publish: kind === 'publish',
    isPush: kind === 'push',
    isForcePush: kind === 'force_push',
    isSync: kind === 'sync',
    isSyncPushStage: kind === 'sync' && isSyncPushStageError(error),
    isFetch: kind === 'fetch',
    isFastForward: kind === 'fast_forward',
    isRebase: kind === 'rebase'
  })
}

export function refreshSourceControlAfterRemoteAction({
  refreshGitStatus,
  refreshBranchCompare,
  refreshGitHistory,
  onError = (error) => console.warn('[SourceControl] post-remote refresh failed', error)
}: {
  refreshGitStatus: () => Promise<void>
  refreshBranchCompare: () => Promise<void>
  refreshGitHistory: () => Promise<void>
  onError?: (error: unknown) => void
}): void {
  // Why: fetch/sync can move the remote base without touching local files; refresh all three projections so branch compare re-runs immediately.
  void Promise.all([refreshGitStatus(), refreshBranchCompare(), refreshGitHistory()]).catch(onError)
}

function remoteActionErrorMatchesSettledConflictOperation(
  kind: SourceControlActionError['kind'],
  operation: GitConflictOperation
): boolean {
  if (kind === 'rebase' || kind === 'abort_rebase') {
    return operation === 'rebase'
  }
  if (kind === 'abort_merge') {
    return operation === 'merge'
  }
  if (kind === 'pull' || kind === 'sync') {
    return operation === 'merge' || operation === 'rebase'
  }
  return false
}

export function clearRemoteActionErrorsForCompletedConflictOperations({
  remoteActionErrors,
  previousConflictOperations,
  currentConflictOperations
}: {
  remoteActionErrors: Record<string, SourceControlActionError | null>
  previousConflictOperations: Record<string, GitConflictOperation>
  currentConflictOperations: Record<string, GitConflictOperation>
}): Record<string, SourceControlActionError | null> {
  let next: Record<string, SourceControlActionError | null> | null = null
  for (const [worktreeId, error] of Object.entries(remoteActionErrors)) {
    if (!error) {
      continue
    }
    const previousOperation = previousConflictOperations[worktreeId] ?? 'unknown'
    const currentOperation = currentConflictOperations[worktreeId] ?? 'unknown'
    if (
      previousOperation === 'unknown' ||
      currentOperation !== 'unknown' ||
      !remoteActionErrorMatchesSettledConflictOperation(error.kind, previousOperation)
    ) {
      continue
    }
    next ??= { ...remoteActionErrors }
    next[worktreeId] = null
  }
  return next ?? remoteActionErrors
}
