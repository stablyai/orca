import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import {
  buildProjectGroupOwnerIndex,
  getProjectGroupIdentity,
  getProjectGroupOwnerHostId,
  getProjectGroupOwnerSubtreeIdentities,
  getProjectGroupSubtreeIds
} from '../../../shared/project-groups'
import {
  resolveFolderWorkspaceCatalogOwnerHostId,
  resolveFolderWorkspaceProjectGroupWithLegacySsh
} from '../../../shared/folder-workspaces'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

export type FolderWorkspaceConnectionState = {
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
  activeWorktreeId?: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
}

function getFolderScopeCandidateRepos(args: {
  folderPath: string
  projectGroup: ProjectGroup
  ownerHostId: ExecutionHostId
  inferLegacyOwner: boolean
  connectionId?: string | null
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}): Repo[] {
  const groupIdentities = getProjectGroupOwnerSubtreeIdentities(
    args.projectGroups,
    args.projectGroup
  )
  const legacyGroupIds = args.inferLegacyOwner
    ? getProjectGroupSubtreeIds(args.projectGroups, args.projectGroup.id)
    : null
  const repoIsInGroup = (repo: Repo): boolean =>
    typeof repo.projectGroupId === 'string' &&
    (legacyGroupIds
      ? legacyGroupIds.has(repo.projectGroupId)
      : groupIdentities.has(
          getProjectGroupIdentity(repo.projectGroupId, getRepoExecutionHostId(repo))
        ))
  const groupRepos = args.repos.filter((repo) => repoIsInGroup(repo))
  const pathRepos = args.repos.filter(
    (repo) =>
      (args.inferLegacyOwner || getRepoExecutionHostId(repo) === args.ownerHostId) &&
      !repoIsInGroup(repo) &&
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

function findFolderWorkspaceScope(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string,
  ownerHostId?: ExecutionHostId
): {
  workspace: FolderWorkspace
  projectGroup: ProjectGroup
  ownerHostId: ExecutionHostId
  inferLegacyOwner: boolean
} | null {
  const candidates = state.folderWorkspaces.filter((entry) => entry.id === folderWorkspaceId)
  const activeScope = parseWorkspaceKey(state.activeWorktreeId ?? '')
  const activeOwnerHostId =
    activeScope?.type === 'folder' && activeScope.folderWorkspaceId === folderWorkspaceId
      ? (activeScope.ownerHostId ??
        (candidates.length > 1 ? state.activeWorkspaceExecutionHostId : undefined))
      : undefined
  const requestedOwnerHostId = ownerHostId ?? activeOwnerHostId ?? undefined
  const workspace = requestedOwnerHostId
    ? candidates.find(
        (entry) =>
          resolveFolderWorkspaceCatalogOwnerHostId(entry, state.projectGroups) ===
          requestedOwnerHostId
      )
    : candidates.length === 1
      ? candidates[0]
      : undefined
  if (!workspace) {
    return null
  }
  const projectGroupIndex = buildProjectGroupOwnerIndex(state.projectGroups)
  const projectGroup = resolveFolderWorkspaceProjectGroupWithLegacySsh(projectGroupIndex, workspace)
  if (!projectGroup) {
    return null
  }
  return {
    workspace,
    projectGroup,
    ownerHostId: getProjectGroupOwnerHostId(projectGroup),
    inferLegacyOwner: projectGroupIndex.byId.get(projectGroup.id)?.length === 1
  }
}

export function getFolderWorkspaceCandidateRepos(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string,
  ownerHostId?: ExecutionHostId
): Repo[] {
  const scope = findFolderWorkspaceScope(state, folderWorkspaceId, ownerHostId)
  if (!scope) {
    return []
  }
  return getFolderScopeCandidateRepos({
    folderPath: scope.workspace.folderPath,
    projectGroup: scope.projectGroup,
    ownerHostId: scope.ownerHostId,
    inferLegacyOwner: scope.inferLegacyOwner,
    connectionId: scope.workspace.connectionId ?? scope.projectGroup.connectionId ?? null,
    projectGroups: state.projectGroups,
    repos: state.repos
  })
}

export function getFolderWorkspaceConnectionId(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string,
  ownerHostId?: ExecutionHostId
): string | null | undefined {
  const scope = findFolderWorkspaceScope(state, folderWorkspaceId, ownerHostId)
  if (!scope) {
    return undefined
  }
  const { workspace, projectGroup } = scope
  const explicitHost = parseExecutionHostId(workspace.executionHostId)
  if (explicitHost) {
    return explicitHost.kind === 'ssh' ? explicitHost.targetId : null
  }
  const scopeConnectionId = workspace.connectionId ?? projectGroup.connectionId ?? null
  const candidateRepos = getFolderWorkspaceCandidateRepos(
    state,
    folderWorkspaceId,
    scope.ownerHostId
  )
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
