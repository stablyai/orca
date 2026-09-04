import type { Worktree } from '../../../shared/worktree/types'
import type { AppState } from '@/store/types'
import { findIndexedWorktreeOwner } from './worktree-runtime-owner-index'

/**
 * The workspace row behind a host-qualified activation whose host was named by something
 * the catalog cannot outrank — a live pty id, which embeds its own owner.
 *
 * The host index files a row with no `hostId` under `local`, so a remote pty in a workspace
 * that never got a host stamp resolves to nothing and activation refuses outright. Answering
 * with that single unstamped publication is a refinement, not the silent substitution
 * `docs/reference/ssh-execution-boundary.md` forbids: the row names no host to contradict the
 * pty's. A rival stamped publication of the same id makes the index `ambiguous`, so a genuine
 * two-host collision still resolves to nothing here.
 */
export function findWorktreeClaimedByNoHost(
  state: Pick<AppState, 'worktreesByRepo'>,
  worktreeId: string
): Worktree | undefined {
  const owner = findIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  if (!owner || owner.hostId || owner.runtimeOwnerEnvironmentId?.trim()) {
    return undefined
  }
  return owner as Worktree
}
