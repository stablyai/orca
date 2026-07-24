import { isPathInsideOrEqual } from './cross-platform-path'
import { getProjectGroupSubtreeIds } from './project-groups'
import type { ProjectGroup, Repo } from './types'

export type FolderWorkspacePathConnectionResolution =
  | { kind: 'local' }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'ambiguous' }

type FolderConnectionRepo = Pick<Repo, 'projectGroupId' | 'path' | 'connectionId'>

function getFolderScopeCandidateRepos(args: {
  folderPath: string
  projectGroupId?: string | null
  connectionId?: string | null
  projectGroups: readonly Pick<ProjectGroup, 'id' | 'parentGroupId'>[]
  repos: readonly FolderConnectionRepo[]
}): FolderConnectionRepo[] {
  const groupIds = args.projectGroupId
    ? getProjectGroupSubtreeIds(args.projectGroups, args.projectGroupId)
    : null
  const groupRepos = groupIds
    ? args.repos.filter(
        (repo) => typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)
      )
    : []
  const pathRepos = args.repos.filter(
    (repo) =>
      !(groupIds && typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) &&
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

export function inferFolderWorkspacePathConnection(args: {
  folderPath: string
  projectGroupId?: string | null
  connectionId?: string | null
  projectGroups: readonly Pick<ProjectGroup, 'id' | 'parentGroupId'>[]
  repos: readonly FolderConnectionRepo[]
}): FolderWorkspacePathConnectionResolution {
  const candidateRepos = getFolderScopeCandidateRepos(args)
  let hasLocalRepo = false
  const connectionIds = new Set<string>()
  for (const repo of candidateRepos) {
    if (repo.connectionId) {
      connectionIds.add(repo.connectionId)
    } else {
      hasLocalRepo = true
    }
  }
  if (args.connectionId) {
    const hasDifferentSshConnection = [...connectionIds].some(
      (connectionId) => connectionId !== args.connectionId
    )
    if (hasLocalRepo || hasDifferentSshConnection) {
      return { kind: 'ambiguous' }
    }
    return { kind: 'ssh', connectionId: args.connectionId }
  }
  if (hasLocalRepo && connectionIds.size > 0) {
    return { kind: 'ambiguous' }
  }
  if (connectionIds.size === 0) {
    return { kind: 'local' }
  }
  if (connectionIds.size === 1) {
    return { kind: 'ssh', connectionId: [...connectionIds][0] }
  }
  return { kind: 'ambiguous' }
}
