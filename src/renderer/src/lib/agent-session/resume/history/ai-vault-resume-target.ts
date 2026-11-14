import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getAiVaultResumeWorkspaceExecutionHostId as getWorkspaceExecutionHostId,
  getAiVaultResumeWorkspaceTargetStatus as getWorkspaceTargetStatus,
  type AiVaultResumeTargetStatus
} from '../../../../../../shared/ai-vault/resume/ai-vault-resume-target'
import type { AppState } from '@/store/types'
import { getIndexedWorktreeMap } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

type AiVaultResumeWorkspaceState = Pick<
  AppState,
  'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'
>

export function getAiVaultResumeWorkspaceExecutionHostId(
  state: AiVaultResumeWorkspaceState,
  workspaceId: string | null
): ExecutionHostId | null {
  return getWorkspaceExecutionHostId(resumeWorkspaceCatalog(state), workspaceId)
}

export function getAiVaultResumeWorkspaceTargetStatus(
  state: AiVaultResumeWorkspaceState,
  workspaceId: string | null
): AiVaultResumeTargetStatus {
  return getWorkspaceTargetStatus(resumeWorkspaceCatalog(state), workspaceId)
}

function resumeWorkspaceCatalog(state: AiVaultResumeWorkspaceState) {
  return {
    folderWorkspaces: selectFolderWorkspaces(state),
    projectGroups: state.projectGroups,
    repos: state.repos,
    findWorktree: (worktreeId: string) =>
      getIndexedWorktreeMap(selectWorktreesByRepo(state) ?? {}).get(worktreeId)
  }
}
