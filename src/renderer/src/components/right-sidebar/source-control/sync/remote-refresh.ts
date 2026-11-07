import { GIT_GRAPH_REFRESH_EVENT } from '@/lib/git-graph-tab'
import {
  isSyncPushStageError,
  resolveRemoteOperationErrorMessage
} from '@/lib/source-control/remote/source-control-remote-error'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlActionError } from './action-error'
import type { RemoteOpKind } from '../review/source-control-primary-action-types'

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
  worktreeId,
  refreshGitStatus,
  refreshBranchCompare,
  refreshGitHistory,
  onError = (error) => console.warn('[SourceControl] post-remote refresh failed', error)
}: {
  worktreeId: string
  refreshGitStatus: () => Promise<void>
  refreshBranchCompare: () => Promise<void>
  refreshGitHistory: () => Promise<void>
  onError?: (error: unknown) => void
}): void {
  window.dispatchEvent(new CustomEvent(GIT_GRAPH_REFRESH_EVENT, { detail: worktreeId }))
  // Fetch/sync can move the remote base without local file changes; refresh every projection.
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

/** True once status shows the conflict operation behind this failure has ended. */
export function remoteActionErrorSettledByConflictOperation(
  error: SourceControlActionError,
  previousOperation: GitConflictOperation,
  currentOperation: GitConflictOperation
): boolean {
  return (
    previousOperation !== 'unknown' &&
    currentOperation === 'unknown' &&
    remoteActionErrorMatchesSettledConflictOperation(error.kind, previousOperation)
  )
}
