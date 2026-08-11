import type { FolderWorkspace, ProjectGroup, Repo } from '../../../shared/types'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { getProjectGroupSubtreeIds } from '../../../shared/project-groups'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { resolveFolderWorkspaceExecutionHostId } from './folder-workspace-execution-host'
import { findIndexedFolderWorkspaceOwner } from './worktree-runtime-owner-index'

export type FolderWorkspaceConnectionState = {
  folderWorkspaces: FolderWorkspace[]
  projectGroups: ProjectGroup[]
  repos: Repo[]
  activeWorktreeId?: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
}

type ResolvedFolderScope = {
  workspace: FolderWorkspace
  group: ProjectGroup | null
  projectGroups: readonly ProjectGroup[]
  connectionId: string | null
  hasConnectionScope: boolean
  repoHostFilter: ExecutionHostId | null
}

function getGroupHostId(group: ProjectGroup): ExecutionHostId | null {
  return resolveFolderWorkspaceExecutionHostId({ folderWorkspace: {}, projectGroup: group })
}

function getWorkspaceHostId(workspace: FolderWorkspace): ExecutionHostId | null {
  return resolveFolderWorkspaceExecutionHostId({ folderWorkspace: workspace })
}

function getPreferredFolderHostId(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string
): ExecutionHostId | undefined {
  return state.activeWorktreeId === folderWorkspaceKey(folderWorkspaceId)
    ? (state.activeWorkspaceExecutionHostId ?? undefined)
    : undefined
}

function selectFolderGroup(
  state: FolderWorkspaceConnectionState,
  workspace: FolderWorkspace
): { group: ProjectGroup | null; matchingRows: ProjectGroup[] } | null {
  const matchingRows = state.projectGroups.filter((group) => group.id === workspace.projectGroupId)
  if (matchingRows.length <= 1) {
    return { group: matchingRows[0] ?? null, matchingRows }
  }

  const workspaceHostId = getWorkspaceHostId(workspace)
  if (!workspaceHostId) {
    return null
  }
  const hostMatches = matchingRows.filter((group) => getGroupHostId(group) === workspaceHostId)
  return hostMatches.length === 1 ? { group: hostMatches[0]!, matchingRows } : null
}

function getConnectionScope(
  workspace: FolderWorkspace,
  group: ProjectGroup | null
): Pick<ResolvedFolderScope, 'connectionId' | 'hasConnectionScope'> | null {
  const workspaceHost = parseExecutionHostId(workspace.executionHostId)
  const groupHost = parseExecutionHostId(group?.executionHostId)
  const hasConnectionScope = Boolean(
    workspaceHost ||
    groupHost?.kind === 'runtime' ||
    workspace.connectionId !== undefined ||
    groupHost ||
    group?.connectionId !== undefined
  )
  if (!hasConnectionScope) {
    return { connectionId: null, hasConnectionScope: false }
  }

  const hostId = resolveFolderWorkspaceExecutionHostId({
    folderWorkspace: workspace,
    projectGroup: group
  })
  const host = parseExecutionHostId(hostId)
  if (!host) {
    return null
  }
  return {
    connectionId: host.kind === 'ssh' ? host.targetId : null,
    hasConnectionScope: true
  }
}

function resolveFolderScope(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string
): ResolvedFolderScope | null {
  const preferredHostId = getPreferredFolderHostId(state, folderWorkspaceId)
  const workspace = findIndexedFolderWorkspaceOwner(
    state.folderWorkspaces,
    folderWorkspaceId,
    preferredHostId
  ) as FolderWorkspace | null
  if (!workspace) {
    return null
  }

  const selectedGroup = selectFolderGroup(state, workspace)
  if (!selectedGroup) {
    return null
  }
  const connectionScope = getConnectionScope(workspace, selectedGroup.group)
  if (!connectionScope) {
    return null
  }

  const selectedGroupHostId = selectedGroup.group ? getGroupHostId(selectedGroup.group) : null
  const projectGroups =
    selectedGroup.matchingRows.length > 1 && selectedGroupHostId
      ? state.projectGroups.filter((group) => getGroupHostId(group) === selectedGroupHostId)
      : state.projectGroups
  const workspaceHost = parseExecutionHostId(workspace.executionHostId)?.id ?? null
  const repoHostFilter =
    workspaceHost ??
    (workspace.connectionId === null
      ? 'local'
      : selectedGroup.matchingRows.length > 1
        ? selectedGroupHostId
        : null)
  return {
    workspace,
    group: selectedGroup.group,
    projectGroups,
    ...connectionScope,
    repoHostFilter
  }
}

function getFolderScopeCandidateRepos(args: {
  folderPath: string
  projectGroupId: string
  connectionId: string | null
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
  repoHostFilter: ExecutionHostId | null
}): Repo[] {
  const groupIds = getProjectGroupSubtreeIds(args.projectGroups, args.projectGroupId)
  const hostMatches = (repo: Repo): boolean =>
    !args.repoHostFilter || getRepoExecutionHostId(repo) === args.repoHostFilter
  const groupRepos = args.repos.filter(
    (repo) =>
      typeof repo.projectGroupId === 'string' &&
      groupIds.has(repo.projectGroupId) &&
      hostMatches(repo)
  )
  const pathRepos = args.repos.filter(
    (repo) =>
      !(typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) &&
      isPathInsideOrEqual(args.folderPath, repo.path) &&
      hostMatches(repo)
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

function getCandidateReposForScope(
  state: FolderWorkspaceConnectionState,
  scope: ResolvedFolderScope
): Repo[] {
  return getFolderScopeCandidateRepos({
    folderPath: scope.workspace.folderPath,
    projectGroupId: scope.workspace.projectGroupId,
    connectionId: scope.connectionId,
    projectGroups: scope.projectGroups,
    repos: state.repos,
    repoHostFilter: scope.repoHostFilter
  })
}

export function getFolderWorkspaceCandidateRepos(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string
): Repo[] {
  const scope = resolveFolderScope(state, folderWorkspaceId)
  return scope ? getCandidateReposForScope(state, scope) : []
}

export function getFolderWorkspaceConnectionId(
  state: FolderWorkspaceConnectionState,
  folderWorkspaceId: string
): string | null | undefined {
  const scope = resolveFolderScope(state, folderWorkspaceId)
  if (!scope) {
    return undefined
  }
  if (scope.workspace.connectionId === null) {
    return null
  }

  const candidateRepos = getCandidateReposForScope(state, scope)
  let hasLocalRepo = false
  const connectionIds = new Set<string>()
  for (const repo of candidateRepos) {
    if (repo.connectionId) {
      connectionIds.add(repo.connectionId)
    } else {
      hasLocalRepo = true
    }
  }
  if (scope.hasConnectionScope) {
    if (scope.connectionId) {
      const hasDifferentSshConnection = [...connectionIds].some(
        (connectionId) => connectionId !== scope.connectionId
      )
      if (hasLocalRepo || hasDifferentSshConnection) {
        return undefined
      }
    }
    return scope.connectionId
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
