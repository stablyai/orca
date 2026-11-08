import { useAppStore } from '@/store'
import { resolveWorktreeGitCopyNow, worktreeCopyPushTarget } from '@/lib/worktree-git-copy'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  clearLandedBranchSwitchError,
  getWorktreeOperationStore
} from '../panel/worktree-operation-store'
import { refreshGitStatusForWorktree } from '../sync/git-status-refresh'

/** Polling covers only the active workspace; a picker elsewhere would show stale or unknown changes. */
export function refreshWorktreeCopyStatus(
  worktreeId: string,
  hostId: ExecutionHostId,
  worktreePath: string
): void {
  const copy = resolveWorktreeGitCopyNow(worktreeId, hostId)
  if (!copy) {
    return
  }
  const state = useAppStore.getState()
  void refreshGitStatusForWorktree({
    target: copy.transport,
    ownerHostId: copy.hostId,
    worktreeId,
    worktreePath,
    connectionId: copy.connectionId,
    pushTarget: worktreeCopyPushTarget(state, worktreeId, copy.hostId),
    deps: state,
    request: { admissionTier: 'interactive' }
  }).catch((error: unknown) => console.warn('[BranchPicker] git status refresh failed', error))
}

/** What the Source Control panel does after a landed switch, for a picker outside the panel. */
export function recordWorktreeBranchSwitchLanded(
  worktreeId: string,
  hostId: ExecutionHostId,
  worktreePath: string
): void {
  clearLandedBranchSwitchError(getWorktreeOperationStore(worktreeId, hostId, undefined))
  refreshWorktreeCopyStatus(worktreeId, hostId, worktreePath)
}
