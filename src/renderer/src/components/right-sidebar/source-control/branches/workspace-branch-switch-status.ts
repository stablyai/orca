import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  resolveWorktreeGitCopyNow,
  worktreeCopyPushTarget,
  worktreeGitCopyHostId
} from '@/lib/worktree-git-copy'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  clearLandedBranchSwitchError,
  getWorktreeOperationStore
} from '../panel/worktree-operation-store'
import { refreshGitStatusForWorktree } from '../sync/git-status-refresh'

/** Status slots are keyed by id alone; only the copy the live resolver names may read or write them. */
export function copyOwnsStatusSlot(
  state: AppState,
  worktreeId: string,
  hostId: ExecutionHostId
): boolean {
  return worktreeGitCopyHostId(state, worktreeId) === hostId
}

/** Polling covers only the active workspace; a picker elsewhere would show stale or unknown changes. */
export function refreshWorktreeCopyStatus(
  worktreeId: string,
  hostId: ExecutionHostId,
  worktreePath: string
): void {
  const state = useAppStore.getState()
  const copy = resolveWorktreeGitCopyNow(worktreeId, hostId)
  if (!copy || !copyOwnsStatusSlot(state, worktreeId, hostId)) {
    return
  }
  void refreshGitStatusForWorktree({
    target: copy.transport,
    ownerHostId: copy.hostId,
    worktreeId,
    worktreePath,
    connectionId: copy.connectionId,
    pushTarget: worktreeCopyPushTarget(state, worktreeId, copy.hostId),
    deps: state,
    request: {
      admissionTier: 'interactive',
      reuseLineStats: true,
      // The user can select a twin while this read is in flight.
      shouldApply: () => copyOwnsStatusSlot(useAppStore.getState(), worktreeId, hostId)
    }
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
