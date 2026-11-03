import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { resolveQualifiedIndexedFolderWorkspace } from '@/store/workspace-record-selectors'
import { findIndexedProjectGroupOwner } from '@/lib/worktree-runtime-owner-index'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace-create-error-format'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { getActiveSidebarWorkspaceId, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

export async function createFolderWorkspaceFromSidebar(projectGroup: ProjectGroup): Promise<void> {
  if (!projectGroup.parentPath) {
    return
  }
  const { createFolderWorkspace } = useAppStore.getState()
  const host = parseExecutionHostId(projectGroup.executionHostId)
  const runtimeEnvironmentId = host?.kind === 'runtime' ? host.environmentId : null
  try {
    await submitFolderWorkspaceCreate({
      projectGroup,
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: undefined,
      agentCmdOverrides: undefined,
      runtimeEnvironmentId,
      createFolderWorkspace: (input) => createFolderWorkspace(input, { runtimeEnvironmentId }),
      onOpenChange: () => {}
    })
  } catch (error) {
    toast.error(getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error)))
  }
}

export function createFolderWorkspaceFromCurrent(): boolean {
  const state = useAppStore.getState()
  const workspaceId = getActiveSidebarWorkspaceId(state.activeWorkspaceKey, state.activeWorktreeId)
  const scope = workspaceId ? parseWorkspaceKey(workspaceId) : null
  if (scope?.type !== 'folder') {
    return false
  }
  const result = resolveQualifiedIndexedFolderWorkspace(
    state,
    scope.folderWorkspaceId,
    state.activeWorkspaceExecutionHostId ?? undefined
  )
  if (result.kind !== 'selected') {
    return false
  }
  const group = findIndexedProjectGroupOwner(
    state.projectGroups,
    result.value.workspace.projectGroupId,
    result.value.hostId
  )
  if (!group?.parentPath) {
    return false
  }
  void createFolderWorkspaceFromSidebar(group)
  return true
}
