import { getActiveWorkspaceExecutionHostId } from '@/lib/workspace/ownership/active-workspace-host'
import { resolveWorktreeGitCopy } from '@/lib/workspace/ownership/worktree-git-copy'
import type { RuntimeGitContext } from '@/runtime/source-control/git/runtime-git-client-context'
import type { AppState } from '@/store/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'

/** Git status context for one host's copy of a sidebar row; null when that copy cannot be placed. */
export function resolveWorktreeStatusReadContext(
  state: AppState,
  worktree: Pick<Worktree, 'id' | 'path' | 'hostId'>
): RuntimeGitContext | null {
  const selectedHostId = getActiveWorkspaceExecutionHostId(state, worktree.id)
  // An unstamped row is the local copy; resolving it through another host's selection would read the twin.
  if (!worktree.hostId && selectedHostId && selectedHostId !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  // The copy resolver routes paired runtimes and SSH connections, and refuses owners it cannot place.
  const copy = resolveWorktreeGitCopy(state, worktree.id, worktree.hostId ?? null)
  if (!copy) {
    return null
  }
  return {
    target: copy.transport,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    connectionId: copy.connectionId
  }
}
