import type { AppState } from '@/store/types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
import { resolveFolderWorkspaceExecutionHostId } from '../../lib/folder-workspace-execution-host'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner
} from '../../lib/worktree-runtime-owner-index'

export type DashboardFolderCatalogState = Pick<AppState, 'folderWorkspaces' | 'projectGroups'>

export type DashboardFolderCatalogOwner = {
  folderWorkspace: FolderWorkspace
  projectGroup: ProjectGroup | null
  executionHostId: ExecutionHostId
}

function findFolderWorkspace(
  folderWorkspaces: readonly FolderWorkspace[],
  folderWorkspaceId: string
): FolderWorkspace | null {
  const indexedOwner = findIndexedFolderWorkspaceOwner(folderWorkspaces, folderWorkspaceId)
  return folderWorkspaces.find((workspace) => workspace === indexedOwner) ?? null
}

function findProjectGroup(
  projectGroups: readonly ProjectGroup[],
  folderWorkspace: FolderWorkspace
): ProjectGroup | null | undefined {
  const candidates = projectGroups.filter((group) => group.id === folderWorkspace.projectGroupId)
  if (candidates.length === 0) {
    return null
  }
  const indexedOwner = findIndexedProjectGroupOwner(projectGroups, folderWorkspace.projectGroupId)
  const uniqueGroup = projectGroups.find((group) => group === indexedOwner)
  if (uniqueGroup) {
    return uniqueGroup
  }

  const ownerHostIds = new Set<ExecutionHostId>()
  const sourceHostId = parseExecutionHostId(folderWorkspace.runtimeSourceExecutionHostId)?.id
  const directHostId = resolveFolderWorkspaceExecutionHostId({ folderWorkspace })
  if (sourceHostId) {
    ownerHostIds.add(sourceHostId)
  }
  if (directHostId) {
    ownerHostIds.add(directHostId)
  }
  const matches = new Set<ProjectGroup>()
  for (const hostId of ownerHostIds) {
    const owner = findIndexedProjectGroupOwner(
      projectGroups,
      folderWorkspace.projectGroupId,
      hostId
    )
    const group = projectGroups.find((candidate) => candidate === owner)
    if (group) {
      matches.add(group)
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined
}

export function resolveDashboardFolderCatalogOwner(
  state: DashboardFolderCatalogState,
  folderWorkspaceId: string
): DashboardFolderCatalogOwner | null {
  const folderWorkspace = findFolderWorkspace(state.folderWorkspaces, folderWorkspaceId)
  if (!folderWorkspace) {
    return null
  }
  const projectGroup = findProjectGroup(state.projectGroups, folderWorkspace)
  if (projectGroup === undefined) {
    return null
  }
  const resolvedHostId = resolveFolderWorkspaceExecutionHostId({
    folderWorkspace,
    projectGroup,
    fallbackHostId: 'local'
  })
  if (!resolvedHostId) {
    return null
  }
  return { folderWorkspace, projectGroup, executionHostId: resolvedHostId }
}
