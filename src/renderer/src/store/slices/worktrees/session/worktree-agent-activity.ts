import type { AppState } from '../../../types'
import { RECENT_STAMP_THROTTLE_MS } from '../../../../../../shared/sidebar-list/sorting/sort-stamps'
import { isFloatingWorkspaceId } from '../../../../../../shared/workspace/identity/floating-workspace-worktree'
import { findKnownWorktreeById } from '../listing/detected-worktree-meta'

/** Stamp Recent for agent work with no PTY and no unread raise (a chat worker's finish). Throttled like the
 *  host's sort stamps, so a busy worker costs at most one store write and persist per window. */
export function noteWorktreeAgentActivity(state: AppState, worktreeId: string): void {
  // The floating workspace's row is synthetic: its stamp would never land, so every turn would persist.
  if (isFloatingWorkspaceId(worktreeId)) {
    return
  }
  const lastActivityAt = findKnownWorktreeById(state, worktreeId)?.lastActivityAt
  if (lastActivityAt === undefined || Date.now() - lastActivityAt < RECENT_STAMP_THROTTLE_MS) {
    return
  }
  state.bumpWorktreeActivity(worktreeId)
}
