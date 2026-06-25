import type { FolderWorkspace, ProjectGroup, Repo } from '../../../shared/types'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { getProjectGroupSubtreeIds } from '../../../shared/project-groups'

export type FolderWorkspaceConnectionState = {
  folderWorkspaces: FolderWorkspace[]
  projectGroups: ProjectGroup[]
  repos: Repo[]
}

function getFolderScopeCandidateRepos(args: {
  folderPath: string
  projectGroupId: string
  connectionId?: string | null
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}): Repo[] {
  const groupIds = getProjectGroupSubtreeIds(args.projectGroups, args.projectGroupId)
  const groupRepos = args.repos.filter(
    (repo) => typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)
  )
  const pathRepos = args.repos.filter(
    (repo) =>
      !(typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) &&
      isPathInsideOrEqual(args.folderPath, repo.path)
  )
  if (args.connectionId) {
    return [
      ...groupRepos,
      ...pathRepos.filter((repo) => (repo.connectionId ?? null) === args.connectionId)
    ]
  }
  if (groupRepos.length === 0) {
    return pathRepos
  }
  const groupConnectionIds = new Set(groupRepos.map((repo) => repo.connectionId ?? null))
  return [
    ...groupRepos,
    ...pathRepos.filter((repo) => groupConnectionIds.has(repo.connectionId ?? null))
  ]
}

export function getFolderWorkspaceCandidateRepos(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string
): Repo[] {
  const workspace = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return []
  }
  const group = state.projectGroups.find((entry) => entry.id === workspace.projectGroupId)
  return getFolderScopeCandidateRepos({
    folderPath: workspace.folderPath,
    projectGroupId: workspace.projectGroupId,
    connectionId: workspace.connectionId ?? group?.connectionId ?? null,
    projectGroups: state.projectGroups,
    repos: state.repos
  })
}

export function getFolderWorkspaceConnectionId(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string
): string | null | undefined {
  const workspace = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return undefined
  }
  const scopeConnectionId =
    workspace.connectionId ??
    state.projectGroups.find((entry) => entry.id === workspace.projectGroupId)?.connectionId ??
    null
  const candidateRepos = getFolderWorkspaceCandidateRepos(state, folderWorkspaceId)
  let hasLocalRepo = false
  const connectionIds = new Set<string>()
  for (const repo of candidateRepos) {
    if (repo.connectionId) {
      connectionIds.add(repo.connectionId)
    } else {
      hasLocalRepo = true
    }
  }
  if (scopeConnectionId) {
    const hasDifferentSshConnection = [...connectionIds].some(
      (connectionId) => connectionId !== scopeConnectionId
    )
    if (hasLocalRepo || hasDifferentSshConnection) {
      return undefined
    }
    return scopeConnectionId
  }
  if (candidateRepos.length === 0) {
    return null
  }
  if (hasLocalRepo && connectionIds.size > 0) {
    return undefined
  }
  if (connectionIds.size === 0) {
    return null
  }
  if (connectionIds.size === 1) {
    return [...connectionIds][0]
  }
  return undefined
}
