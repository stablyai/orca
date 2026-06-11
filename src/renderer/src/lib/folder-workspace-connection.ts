import type { FolderWorkspace, ProjectGroup, Repo } from '../../../shared/types'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { getProjectGroupSubtreeIds } from '../../../shared/project-groups'

export type FolderWorkspaceConnectionState = {
  folderWorkspaces: FolderWorkspace[]
  projectGroups: ProjectGroup[]
  repos: Repo[]
}

export function getFolderWorkspaceConnectionId(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string
): string | null | undefined {
  const workspace = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return undefined
  }

  const groupIds = getProjectGroupSubtreeIds(state.projectGroups, workspace.projectGroupId)
  const candidateRepos = state.repos.filter(
    (repo) =>
      (typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) ||
      isPathInsideOrEqual(workspace.folderPath, repo.path)
  )
  if (candidateRepos.length === 0) {
    return null
  }

  const connectionIds = new Set<string>()
  for (const repo of candidateRepos) {
    if (repo.connectionId) {
      connectionIds.add(repo.connectionId)
    }
  }
  if (connectionIds.size === 0) {
    return null
  }
  if (connectionIds.size === 1) {
    return [...connectionIds][0]
  }
  return undefined
}
