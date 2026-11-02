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
  parseExecutionHostId,
  toSshExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from './execution-host'

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

/** Resolve legacy connectionId and unified SSH ownership in both candidate filters and the resolver; raw reads can discard SSH-only rows early.
 * Non-SSH hosts retain raw connectionId for runtime-nested targets, which require the environment to dial. */
function getRepoScopeConnectionId(repo: FolderHostRepo): string | null {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'ssh' ? host.targetId : normalizeHostPart(repo.connectionId)
}

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
  const groupHosts = new Set(groups.map(getRepoExecutionHostId))
  const explicitHost =
    parseExecutionHostId(workspace.executionHostId) ??
    (!normalizeHostPart(workspace.connectionId) &&
    groupHosts.size === 1 &&
    groups.some(
      (group) =>
        parseExecutionHostId(group.executionHostId) || normalizeHostPart(group.connectionId)
    )
      ? parseExecutionHostId([...groupHosts][0])
      : null)
  const scopeConnections = new Set(groups.map(getRepoScopeConnectionId))
  const scopeConnectionId =
    normalizeHostPart(workspace.connectionId) ??
    (scopeConnections.size === 1 ? [...scopeConnections][0] : null)
  switch (explicitHost?.kind) {
    case 'ssh':
      return { kind: 'ssh', targetId: explicitHost.targetId }
    case 'runtime':
      return {
        kind: 'runtime',
        environmentId: explicitHost.environmentId,
        sshTargetId: scopeConnectionId
      }
    case 'local':
      return { kind: 'local' }
    case undefined:
      break
  }
  if (!normalizeHostPart(workspace.connectionId) && groupHosts.size > 1) {
    return { kind: 'ambiguous' }
  }
  const candidateRepos = candidateReposForFolder(state, workspace)
  let hasLocalRepo = false
  const connectionIds = new Set<string>()
  for (const repo of candidateRepos) {
    const connectionId = getRepoScopeConnectionId(repo)
    if (connectionId) {
      connectionIds.add(connectionId)
    } else {
      hasLocalRepo = true
    }
  }
  if (scopeConnectionId) {
    const hasDifferentSshConnection = [...connectionIds].some(
      (connectionId) => connectionId !== scopeConnectionId
    )
    return hasLocalRepo || hasDifferentSshConnection
      ? { kind: 'ambiguous' }
      : { kind: 'ssh', targetId: scopeConnectionId }
  }
  if (candidateRepos.length === 0 || connectionIds.size === 0) {
    return { kind: 'local' }
  }
  if (hasLocalRepo || connectionIds.size > 1) {
    return { kind: 'ambiguous' }
  }
  return { kind: 'ssh', targetId: [...connectionIds][0] }
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
  const rows =
    state.folderWorkspaces?.filter((workspace) => workspace.id === folderWorkspaceId) ?? []
  let underivable = false
  const matches = rows.flatMap((workspace) => {
    const groups = state.projectGroups?.filter((group) => group.id === workspace.projectGroupId)
    const explicit =
      parseExecutionHostId(workspace.executionHostId) ||
      normalizeHostPart(workspace.connectionId) ||
      groups?.some(
        (group) =>
          parseExecutionHostId(group.executionHostId) || normalizeHostPart(group.connectionId)
      )
    const incomplete = !explicit && (!state.projectGroups || !state.repos || !workspace.folderPath)
    const host = incomplete
      ? { kind: 'ambiguous' as const }
      : resolveFolderWorkspaceRowHost(
          {
            folderWorkspaces: [],
            projectGroups: (state.projectGroups ?? []).map((group) => ({
              ...group,
              parentGroupId: group.parentGroupId ?? null
            })),
            repos: state.repos ?? []
          },
          workspace
        )
    const hostId: ExecutionHostId | null =
      host.kind === 'local'
        ? LOCAL_EXECUTION_HOST_ID
        : host.kind === 'ssh'
          ? toSshExecutionHostId(host.targetId)
          : host.kind === 'runtime'
            ? toRuntimeExecutionHostId(host.environmentId)
            : null
    underivable ||= hostId === null
    return hostId && (!requiredHostId || hostId === requiredHostId)
      ? [
          {
            workspace,
            hostId,
            connectionId:
              host.kind === 'ssh'
                ? host.targetId
                : host.kind === 'runtime'
                  ? host.sshTargetId
                  : null
          }
        ]
      : []
  })
  return matches.length === 1
    ? { kind: 'selected' as const, value: matches[0] }
    : {
        kind:
          rows.length && (underivable || matches.length > 1)
            ? ('ambiguous' as const)
            : ('missing' as const)
      }
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
