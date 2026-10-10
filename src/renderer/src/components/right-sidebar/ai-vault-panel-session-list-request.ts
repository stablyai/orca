import type { AppState } from '@/store/types'
import { getAiVaultResumeWorkspaceExecutionHostId } from '@/lib/ai-vault-resume-target'
import {
  getProjectHostSetupProjectionFromState,
  selectRepoByIdForActiveWorkspace
} from '@/store/selectors'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { resolveAiVaultHostScopeDefaults } from './ai-vault-host-scope'
import { deriveAiVaultScopeSessionPaths } from './ai-vault-scope-paths'
import { buildAiVaultProjectContext } from './ai-vault-session-projects'
import type { AiVaultSessionListRequest } from './ai-vault-session-list-request'
import { readAiVaultViewOptions } from './ai-vault-view-options-persistence'

/** The request the panel sends by default while `workspaceId` is the active workspace, read from
 *  the store through the same selectors and derivations the panel's hooks use. */
export function resolveAiVaultPanelSessionListRequest(
  state: AppState,
  workspaceId: string
): AiVaultSessionListRequest {
  const isActive = workspaceId === state.activeWorktreeId
  const worktree =
    state.getKnownWorktreeById(
      workspaceId,
      isActive ? (state.activeWorkspaceExecutionHostId ?? undefined) : undefined
    ) ?? null
  const allWorktrees = getIndexedAllWorktrees(state.worktreesByRepo)
  const projectHostSetupProjection = getProjectHostSetupProjectionFromState(state)
  const { activeProjectKey } = buildAiVaultProjectContext({
    repos: state.repos,
    worktrees: allWorktrees,
    projectHostSetupProjection,
    activeRepo: selectRepoByIdForActiveWorkspace(
      state,
      isActive ? state.activeRepoId : (worktree?.repoId ?? null)
    ),
    activeWorktree: worktree,
    sessions: []
  })
  return {
    scopePaths: deriveAiVaultScopeSessionPaths(worktree, allWorktrees, {
      activeProjectKey,
      projectHostSetupProjection
    }),
    executionHostScope: resolveAiVaultHostScopeDefaults(
      getAiVaultResumeWorkspaceExecutionHostId(state, workspaceId),
      workspaceId
    ).defaultExecutionHostScope,
    sessionLimit: readAiVaultViewOptions().sessionLimit
  }
}
