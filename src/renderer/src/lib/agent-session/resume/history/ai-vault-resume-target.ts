import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getAiVaultResumeWorkspaceExecutionHostId as getWorkspaceExecutionHostId,
  getAiVaultResumeWorkspaceTargetStatus as getWorkspaceTargetStatus,
  type AiVaultResumeTargetStatus
} from '../../../../../../shared/ai-vault/resume/ai-vault-resume-target'
import type { AppState } from '@/store/types'
import { findAiVaultHistoryWorktree } from './ai-vault-history-worktrees'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'

type AiVaultResumeWorkspaceState = Pick<
  AppState,
  'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'
> &
  Partial<Pick<AppState, 'detectedWorktreesByRepo'>>

export function getAiVaultResumeWorkspaceExecutionHostId(
  state: AiVaultResumeWorkspaceState,
  workspaceId: string | null,
  executionHostId?: ExecutionHostId | null
): ExecutionHostId | null {
  return getWorkspaceExecutionHostId(resumeWorkspaceCatalog(state, executionHostId), workspaceId)
}

export function getAiVaultResumeWorkspaceTargetStatus(
  state: AiVaultResumeWorkspaceState,
  workspaceId: string | null,
  executionHostId?: ExecutionHostId | null
): AiVaultResumeTargetStatus {
  return getWorkspaceTargetStatus(resumeWorkspaceCatalog(state, executionHostId), workspaceId)
}

function resumeWorkspaceCatalog(
  state: AiVaultResumeWorkspaceState,
  executionHostId?: ExecutionHostId | null
) {
  return {
    folderWorkspaces: selectFolderWorkspaces(state),
    projectGroups: state.projectGroups,
    repos: state.repos,
    findWorktree: (worktreeId: string) =>
      findAiVaultHistoryWorktree(state, worktreeId, executionHostId)
  }
}
