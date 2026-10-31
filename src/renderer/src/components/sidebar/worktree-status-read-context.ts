import { getConnectionId } from '@/lib/connection-context'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { repoMatchesHostIdentity } from '@/store/slices/repo-host-identity'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../shared/worktree/types'

/** Git status context for a sidebar row's owner; null when the owner is missing or ambiguous. */
export function resolveWorktreeStatusReadContext(
  state: AppState,
  worktree: Pick<Worktree, 'id' | 'path' | 'repoId' | 'hostId'>
): RuntimeGitContext | null {
  // Host-pinned rows must not resolve through focus; the same id can exist on another host.
  const target = worktree.hostId
    ? ipcOrRuntimeTargetForHostId(worktree.hostId)
    : runtimeTargetForWorkspaceOwner(state, { workspaceId: worktree.id })
  if (!target) {
    return null
  }
  const { hostId } = worktree
  const connectionId = hostId
    ? state.repos.find((repo) => repoMatchesHostIdentity(repo, worktree.repoId, hostId))
        ?.connectionId
    : getConnectionId(worktree.id)
  return {
    target,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    connectionId: connectionId ?? undefined
  }
}
