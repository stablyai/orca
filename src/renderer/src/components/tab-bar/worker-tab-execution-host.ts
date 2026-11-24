import {
  selectWorktreesByRepo,
  selectFolderWorkspaces
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { AppState } from '@/store/types'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'

type HostInputs = Pick<
  AppState,
  | 'worktreesByRepo'
  | 'repos'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
>
const hosts = new Map<
  string,
  { inputs: HostInputs; hostId: ReturnType<typeof getResolvedExecutionHostIdForWorktree> }
>()

/** Status pings do not change workspace ownership or allocate another resolved owner. */
export function workerTabExecutionHost(state: AppState, worktreeId: string) {
  const previous = hosts.get(worktreeId)
  const inputs = previous?.inputs
  if (
    inputs &&
    selectWorktreesByRepo(inputs) === selectWorktreesByRepo(state) &&
    inputs.repos === state.repos &&
    selectFolderWorkspaces(inputs) === selectFolderWorkspaces(state) &&
    inputs.projectGroups === state.projectGroups &&
    inputs.restoredRuntimeHostIdByWorkspaceSessionKey ===
      state.restoredRuntimeHostIdByWorkspaceSessionKey &&
    inputs.activeWorktreeId === state.activeWorktreeId &&
    inputs.activeWorkspaceExecutionHostId === state.activeWorkspaceExecutionHostId
  ) {
    return previous.hostId
  }
  const hostId = getResolvedExecutionHostIdForWorktree(state, worktreeId)
  hosts.set(worktreeId, {
    hostId,
    inputs: {
      worktreesByRepo: selectWorktreesByRepo(state),
      repos: state.repos,
      folderWorkspaces: selectFolderWorkspaces(state),
      projectGroups: state.projectGroups,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
      activeWorktreeId: state.activeWorktreeId,
      activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId
    }
  })
  return hostId
}

export function forgetWorkerTabExecutionHost(worktreeId: string): void {
  hosts.delete(worktreeId)
}
