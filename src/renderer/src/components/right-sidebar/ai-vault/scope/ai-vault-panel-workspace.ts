import type { AppState } from '@/store/types'
import { selectKnownWorktreeById } from '@/store/workspaces/selection/known-worktree-selection'
import { selectRepoByIdForActiveWorkspace } from '@/store/repos/active-workspace-repository'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'

/** A Session History panel's workspace; the host matters as worktree ids repeat across hosts. */
export type AiVaultPanelWorkspace = {
  worktreeId: string
  executionHostId?: ExecutionHostId
}

export type AiVaultPanelWorkspaceRows = {
  worktree: ReturnType<typeof selectKnownWorktreeById>
  repo: ReturnType<typeof selectRepoByIdForActiveWorkspace>
}

export function selectAiVaultPanelWorkspace(
  state: AppState,
  workspace: AiVaultPanelWorkspace
): AiVaultPanelWorkspaceRows {
  const worktree = selectKnownWorktreeById(state, workspace.worktreeId, workspace.executionHostId)
  if (workspace.executionHostId && worktree) {
    const repoId = worktree.repoId
    return {
      worktree,
      repo: selectRepoByIdForActiveWorkspace(
        {
          repos: state.repos,
          activeRepoId: repoId,
          activeWorkspaceExecutionHostId: workspace.executionHostId
        },
        repoId
      )
    }
  }
  const isActive = workspace.worktreeId === state.activeWorktreeId
  return {
    worktree,
    repo: selectRepoByIdForActiveWorkspace(
      state,
      isActive ? state.activeRepoId : (worktree?.repoId ?? null)
    )
  }
}
