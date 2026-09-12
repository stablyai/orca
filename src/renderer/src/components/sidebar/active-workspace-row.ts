import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'

/** Whether this sidebar row is the active workspace, host-qualified when the active host is known. */
export function isActiveWorkspaceRow(
  active: Pick<AppState, 'activeWorktreeId' | 'activeWorkspaceExecutionHostId'>,
  worktree: Pick<Worktree, 'id' | 'hostId'>
): boolean {
  return (
    active.activeWorktreeId === worktree.id &&
    (!active.activeWorkspaceExecutionHostId ||
      composeWorktreeHostIdentity(active.activeWorkspaceExecutionHostId, worktree.id) ===
        getWorktreeHostIdentity(worktree))
  )
}
