import { useAppStore } from '@/store'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { withStructuredSessionRestoreTimeout } from './structured-session-restore-timeout'

/** Load the chat's host's own listing of its workspace, which a cold or reconnecting window may
 *  not hold yet, through the store's catalog loads. False when the user navigated meanwhile, so
 *  this open must not move them. A failed or slow load proves nothing: the caller's fresh check
 *  decides, and its existing message reports a workspace still unlisted. */
export async function loadStructuredChatWorkspaceListing(
  worktreeId: string,
  executionHostId: ExecutionHostId
): Promise<boolean> {
  const navigation = () => {
    const state = useAppStore.getState()
    return [state.activeWorktreeId, state.activeWorkspaceExecutionHostId, state.activeModal]
  }
  const origin = navigation()
  try {
    await withStructuredSessionRestoreTimeout(loadOwnerListing(worktreeId, executionHostId))
  } catch {
    /* Unanswered or refused: the workspace stays unlisted and the open fails as before. */
  }
  return navigation().every((value, index) => value === origin[index])
}

async function loadOwnerListing(worktreeId: string, hostId: ExecutionHostId): Promise<void> {
  const host = parseExecutionHostId(hostId)
  const runtimeEnvironmentId = host?.kind === 'runtime' ? host.environmentId : null
  if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
    // A folder workspace is listed under its project group, so groups load first.
    await useAppStore.getState().fetchProjectGroups({ runtimeEnvironmentId })
    await useAppStore.getState().fetchFolderWorkspaces({ runtimeEnvironmentId })
    return
  }
  if (runtimeEnvironmentId !== null) {
    await useAppStore.getState().fetchRuntimeEnvironmentRepos(runtimeEnvironmentId)
  }
  // Only a repo the host registers is listed; a missing one is not invented here.
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const state = useAppStore.getState()
  if (state.repos.some((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId)) {
    await state.fetchWorktrees(repoId, { executionHostId: hostId })
  }
}
