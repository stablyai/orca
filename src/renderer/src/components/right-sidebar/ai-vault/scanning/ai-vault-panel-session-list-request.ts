import type { AppState } from '@/store/types'
import { getAiVaultResumeWorkspaceExecutionHostId } from '@/lib/agent-session/resume/history/ai-vault-resume-target'
import { getProjectHostSetupProjectionFromState } from '@/store/projects/project-host-setup-selector'
import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { resolveAiVaultHostScopeDefaults } from '../scope/ai-vault-host-scope'
import { DEFAULT_AI_VAULT_SCOPE } from '../scope/ai-vault-scope-state'
import { deriveAiVaultScopeSessionPaths } from '../../../../../../shared/ai-vault/scanning/ai-vault-scope-paths'
import { buildAiVaultProjectContext } from '../scope/ai-vault-session-projects'
import { selectAiVaultPanelWorkspace } from '../scope/ai-vault-panel-workspace'
import type { AiVaultSessionListRequest } from './ai-vault-session-list-request'
import { readAiVaultViewOptions } from '../scope/ai-vault-view-options-persistence'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'

type AiVaultPanelSessionListState = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'detectedWorktreesByRepo'
  | 'floatingWorkspacePath'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'endpointProjectHostSetups'
  | 'endpointProjects'
  | 'repos'
  | 'settings'
  | 'worktreesByRepo'
>

/** The request the panel sends by default while `workspaceId` is the active workspace, read from
 *  the store through the same selectors and derivations the panel's hooks use. */
export function resolveAiVaultPanelSessionListRequest(
  state: AiVaultPanelSessionListState,
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
