import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { floatingWorkspaceId } from '../../../shared/floating-workspace-id'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

/** Keep the host's floating group out of the client's local scratch workspace. */
export function projectFloatingSessionSnapshot<T extends RuntimeMobileSessionTabsResult>(
  snapshot: T,
  environmentId: string
): T {
  return snapshot.worktree === FLOATING_TERMINAL_WORKTREE_ID
    ? { ...snapshot, worktree: floatingWorkspaceId(environmentId) }
    : snapshot
}
