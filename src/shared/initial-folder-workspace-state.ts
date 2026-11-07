import { LOCAL_EXECUTION_HOST_ID } from './execution-host'
import type { PersistedState } from './persisted-state-types'
import { projectHostSetupProjectionFromRepos } from './project-host-setup-projection'
import type { Repo } from './repo-types'
import { getRepoMainWorktreeId } from './worktree/id'
import { worktreeWorkspaceKey } from './workspace-scope'

export function createInitialFolderWorkspaceState(
  state: PersistedState,
  repo: Repo
): PersistedState {
  const repos = [repo]
  const projection = projectHostSetupProjectionFromRepos(repos)
  const worktreeId = getRepoMainWorktreeId(repo)
  return {
    ...state,
    repos,
    projects: [...projection.projects],
    projectHostSetups: [...projection.setups],
    workspaceSession: {
      ...state.workspaceSession,
      activeRepoId: repo.id,
      activeWorktreeId: worktreeId,
      activeWorkspaceKey: worktreeWorkspaceKey(worktreeId),
      activeWorkspaceExecutionHostId: LOCAL_EXECUTION_HOST_ID,
      activeTabId: null
    }
  }
}
