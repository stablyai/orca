/** Share host resolution between main dispatch and renderer projection. Workspace executionHostId pins override repo ownership.
 * Mixed-host scopes return ambiguous; callers must fail visibly rather than defaulting to local. */

import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'
import { isPathInsideOrEqual } from './cross-platform-path'
import { getProjectGroupSubtreeIds } from './project-groups'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeHostPart,
  type ExecutionHostId
} from './execution-host'
import {
  classifyFolderScope,
  folderScopeRepo,
  getRepoScopeConnectionId,
  mergeFolderScopeRepos,
  NO_FOLDER_SCOPE_REPOS,
  pinnedFolderRowHost,
  qualifyFolderWorkspaceRows
} from './folder-workspace-host-decision'

export type FolderWorkspaceHostState = {
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}

/** The fields host resolution reads, so a catalog read over the wire resolves the same way. */
export type FolderHostRepo = {
  path?: string
  projectGroupId?: string | null
  connectionId?: string | null
  executionHostId?: string | null
}

export type FolderHostWorkspace = Pick<FolderWorkspace, 'id' | 'projectGroupId'> & {
  folderPath?: string
  connectionId?: string | null
  executionHostId?: string | null
}

export type FolderHostCatalog<R extends FolderHostRepo = Repo> = {
  folderWorkspaces: readonly (Pick<FolderWorkspace, 'id' | 'folderPath' | 'projectGroupId'> & {
    connectionId?: string | null
    executionHostId?: string | null
  })[]
  projectGroups: readonly (Pick<ProjectGroup, 'id'> & {
    parentGroupId: string | null
    connectionId?: string | null
    executionHostId?: string | null
  })[]
  repos: readonly R[]
}

export type FolderWorkspaceHost =
  | { kind: 'missing' }
  | { kind: 'local' }
  | { kind: 'ssh'; targetId: string }
  // A paired server's folder; `sshTargetId` is that server's own target, addressable only with it.
  | { kind: 'runtime'; environmentId: string; sshTargetId: string | null }
  | { kind: 'ambiguous' }

function getFolderScopeCandidateRepos<R extends FolderHostRepo>(args: {
  folderPath?: string
  projectGroupId: string
  connectionId: string | null
  projectGroups: FolderHostCatalog<R>['projectGroups']
  repos: readonly R[]
}): R[] {
  const groupIds = getProjectGroupSubtreeIds(args.projectGroups, args.projectGroupId)
  // Classify once rather than reading projectGroupId in two filters before the same path predicate.
  const groupRepos: R[] = []
  const pathRepos: R[] = []
  for (const repo of args.repos) {
    const projectGroupId = repo.projectGroupId
    if (typeof projectGroupId === 'string' && groupIds.has(projectGroupId)) {
      groupRepos.push(repo)
    } else if (args.folderPath && repo.path && isPathInsideOrEqual(args.folderPath, repo.path)) {
      pathRepos.push(repo)
    }
  }
  if (args.connectionId) {
    return [
      ...groupRepos,
      ...pathRepos.filter((repo) => getRepoScopeConnectionId(repo) === args.connectionId)
    ]
  }
  if (groupRepos.length === 0) {
    return pathRepos
  }
  // Resolve both sides or legacy/unified group comparisons diverge again.
  const groupConnectionIds = new Set(groupRepos.map(getRepoScopeConnectionId))
  return [
    ...groupRepos,
    ...pathRepos.filter((repo) => groupConnectionIds.has(getRepoScopeConnectionId(repo)))
  ]
}

export function findFolderWorkspaceCandidateRepos<R extends FolderHostRepo>(
  state: FolderHostCatalog<R>,
  folderWorkspaceId: string
): R[] {
  const rows = state.folderWorkspaces.filter((entry) => entry.id === folderWorkspaceId)
  return rows.length === 1 ? candidateReposForFolder(state, rows[0]) : []
}

function candidateReposForFolder<R extends FolderHostRepo>(
  state: FolderHostCatalog<R>,
  workspace: FolderHostWorkspace
): R[] {
  const groups = state.projectGroups.filter((entry) => entry.id === workspace.projectGroupId)
  const connections = new Set(groups.map(getRepoScopeConnectionId))
  return getFolderScopeCandidateRepos({
    folderPath: workspace.folderPath,
    projectGroupId: workspace.projectGroupId,
    connectionId:
      normalizeHostPart(workspace.connectionId) ??
      (connections.size === 1 ? [...connections][0] : null),
    projectGroups: state.projectGroups,
    repos: state.repos
  })
}

export function resolveFolderWorkspaceHost<R extends FolderHostRepo>(
  state: FolderHostCatalog<R>,
  folderWorkspaceId: string
): FolderWorkspaceHost {
  const rows = state.folderWorkspaces.filter((entry) => entry.id === folderWorkspaceId)
  return rows.length === 0
    ? { kind: 'missing' }
    : rows.length !== 1
      ? { kind: 'ambiguous' }
      : resolveFolderWorkspaceRowHost(state, rows[0])
}

export function resolveFolderWorkspaceRowHost<R extends FolderHostRepo>(
  state: FolderHostCatalog<R>,
  workspace: FolderHostWorkspace
): FolderWorkspaceHost {
  const groups = state.projectGroups.filter((entry) => entry.id === workspace.projectGroupId)
  const pinned = pinnedFolderRowHost(workspace, groups)
  if ('host' in pinned) {
    return pinned.host
  }
  let repos = NO_FOLDER_SCOPE_REPOS
  for (const repo of candidateReposForFolder(state, workspace)) {
    repos = mergeFolderScopeRepos(repos, folderScopeRepo(repo))
  }
  return classifyFolderScope(pinned.scopeConnectionId, repos)
}

export { getFolderWorkspaceHostId } from './folder-workspace-host-id'

export type QualifiedFolderHostState<W extends FolderHostWorkspace = FolderHostWorkspace> = {
  folderWorkspaces?: readonly W[]
  projectGroups?: readonly (Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'> &
    Partial<Pick<ProjectGroup, 'parentGroupId'>>)[]
  repos?: readonly FolderHostRepo[]
}

export type QualifiedFolderWorkspaceResult<W extends FolderHostWorkspace> =
  | {
      kind: 'selected'
      value: { workspace: W; hostId: ExecutionHostId; connectionId: string | null }
    }
  | { kind: 'ambiguous' }
  | { kind: 'missing' }

export function resolveQualifiedFolderWorkspaceResult<W extends FolderHostWorkspace>(
  state: QualifiedFolderHostState<W>,
  folderWorkspaceId: string,
  requiredHostId?: ExecutionHostId
): QualifiedFolderWorkspaceResult<W> {
  return qualifyFolderWorkspaceRows(
    state.folderWorkspaces?.filter((workspace) => workspace.id === folderWorkspaceId) ?? [],
    (workspace) => state.projectGroups?.filter((group) => group.id === workspace.projectGroupId),
    (workspace) =>
      resolveFolderWorkspaceRowHost(
        {
          folderWorkspaces: [],
          projectGroups: (state.projectGroups ?? []).map((group) => ({
            ...group,
            parentGroupId: group.parentGroupId ?? null
          })),
          repos: state.repos ?? []
        },
        workspace
      ),
    !!state.projectGroups && !!state.repos,
    requiredHostId
  )
}

export function resolveQualifiedFolderWorkspace(
  state: FolderWorkspaceHostState,
  folderWorkspaceId: string,
  requiredHostId: ExecutionHostId | undefined,
  failure: (kind: 'missing' | 'ambiguous') => Error
) {
  const result = resolveQualifiedFolderWorkspaceResult(state, folderWorkspaceId, requiredHostId)
  if (result.kind !== 'selected') {
    throw failure(result.kind)
  }
  return result.value
}

/** A folder's local project association, scoped to its acquired physical row when supplied. */
export function findLocalFolderWorkspaceRuntimeRepo(
  state: FolderWorkspaceHostState,
  folderWorkspaceId: string,
  selectedFolder?: FolderWorkspace
): Repo | undefined {
  const scoped = {
    ...state,
    folderWorkspaces: selectedFolder ? [selectedFolder] : state.folderWorkspaces
  }
  const result = resolveQualifiedFolderWorkspaceResult(scoped, folderWorkspaceId)
  if (result.kind !== 'selected' || result.value.hostId !== LOCAL_EXECUTION_HOST_ID) {
    return undefined
  }
  const candidates = findFolderWorkspaceCandidateRepos(
    {
      ...scoped,
      repos: state.repos.filter((repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
    },
    folderWorkspaceId
  )
  return candidates.length === 1 ? candidates[0] : undefined
}
