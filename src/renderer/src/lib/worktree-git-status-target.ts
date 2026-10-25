import type { AppState } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { Worktree } from '../../../shared/worktree/types'

/** Where to ask for one worktree's git status: a host-stamped row goes to that host, a legacy row to its resolved owner. */
export function resolveWorktreeGitStatusTarget(
  state: AppState,
  worktree: Pick<Worktree, 'id' | 'repoId' | 'hostId'>
): { target: RuntimeClientTarget; connectionId: string | undefined } | null {
  if (worktree.hostId) {
    const target = ipcOrRuntimeTargetForHostId(worktree.hostId)
    if (!target) {
      return null
    }
    const owner = findRepoForHost(state.repos, worktree.repoId, { hostId: worktree.hostId })
    return { target, connectionId: owner?.connectionId ?? undefined }
  }
  const target = runtimeTargetForWorkspaceOwner(state, { workspaceId: worktree.id })
  return target ? { target, connectionId: getConnectionId(worktree.id) ?? undefined } : null
}
