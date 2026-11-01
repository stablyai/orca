import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'

export function getFolderWorkspaceHostId(
  workspace: FolderWorkspace,
  projectGroups: readonly ProjectGroup[]
): ExecutionHostId {
  const explicitHostId = parseExecutionHostId(workspace.executionHostId)?.id
  if (explicitHostId) {
    return explicitHostId
  }
  if (workspace.connectionId) {
    return toSshExecutionHostId(workspace.connectionId)
  }
  let matchingHostId: ExecutionHostId | undefined
  for (const group of projectGroups) {
    if (group.id !== workspace.projectGroupId) {
      continue
    }
    const hostId = getRepoExecutionHostId(group)
    if (matchingHostId === undefined) {
      matchingHostId = hostId
    } else if (matchingHostId !== hostId) {
      return LOCAL_EXECUTION_HOST_ID
    }
  }
  return matchingHostId ?? LOCAL_EXECUTION_HOST_ID
}
