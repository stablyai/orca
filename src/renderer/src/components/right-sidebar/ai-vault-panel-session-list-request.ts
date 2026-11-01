import type { AppState } from '@/store/types'
import { getAiVaultResumeWorkspaceExecutionHostId } from '@/lib/ai-vault-resume-target'
import { getProjectHostSetupProjectionFromState } from '@/store/selectors'
import { getIndexedAllWorktrees } from '@/store/worktree-repo-index'
import { resolveAiVaultHostScopeDefaults } from './ai-vault-host-scope'
import { DEFAULT_AI_VAULT_SCOPE } from './ai-vault-scope-state'
import { deriveAiVaultScopeSessionPaths } from '../../../../shared/ai-vault-scope-paths'
import { buildAiVaultProjectContext } from './ai-vault-session-projects'
import { selectAiVaultPanelWorkspace } from './ai-vault-panel-workspace'
import type { AiVaultSessionListRequest } from './ai-vault-session-list-request'
import { readAiVaultViewOptions } from './ai-vault-view-options-persistence'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

/** Derive the active workspace request using the same store selectors as the panel hooks. */
export function resolveAiVaultPanelSessionListRequest(
  state: AppState,
  workspaceId: string
): AiVaultSessionListRequest {
  const { worktree, repo } = selectAiVaultPanelWorkspace(state, { worktreeId: workspaceId })
  const allWorktrees = getIndexedAllWorktrees(selectWorktreesByRepo(state))
  const projectHostSetupProjection = getProjectHostSetupProjectionFromState(state)
  const { activeProjectKey } = buildAiVaultProjectContext({
    repos: state.repos,
    worktrees: allWorktrees,
    projectHostSetupProjection,
    activeRepo: repo,
    activeWorktree: worktree,
    sessions: []
  })
  return {
    scopePaths: deriveAiVaultScopeSessionPaths(worktree, allWorktrees, {
      scope: DEFAULT_AI_VAULT_SCOPE,
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
