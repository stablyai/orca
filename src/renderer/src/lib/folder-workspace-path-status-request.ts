import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { FolderWorkspacePathStatusRequest } from '../../../shared/folder-workspace-path-status'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../shared/types'
import { resolveFolderWorkspaceExecutionHostId } from './folder-workspace-execution-host'

type PathStatusOwner = Pick<
  FolderWorkspace | ProjectGroup,
  'connectionId' | 'executionHostId' | 'runtimeSourceExecutionHostId'
>

type RepoPathStatusOwner = Pick<Repo, 'connectionId' | 'executionHostId'>

type SourceHostResolution =
  | { kind: 'resolved'; hostId: ExecutionHostId }
  | { kind: 'none' | 'invalid' }

function resolveConnectionHostId(connectionId: string | null | undefined): SourceHostResolution {
  if (connectionId === undefined) {
    return { kind: 'none' }
  }
  if (connectionId === null) {
    return { kind: 'resolved', hostId: LOCAL_EXECUTION_HOST_ID }
  }
  const normalized = connectionId.trim()
  return normalized
    ? { kind: 'resolved', hostId: toSshExecutionHostId(normalized) }
    : { kind: 'invalid' }
}

function resolveDeclaredSourceHostId(owner: PathStatusOwner): SourceHostResolution {
  const sourceValue = owner.runtimeSourceExecutionHostId
  const sourceHost = parseExecutionHostId(sourceValue)
  if (sourceValue !== undefined && sourceValue !== null && !sourceHost) {
    return { kind: 'invalid' }
  }
  const executionValue = owner.executionHostId
  const executionHost = parseExecutionHostId(executionValue)
  if (executionValue !== undefined && executionValue !== null && !executionHost) {
    return { kind: 'invalid' }
  }
  const connection = resolveConnectionHostId(owner.connectionId)
  if (connection.kind === 'invalid') {
    return connection
  }
  const declaredHosts = new Set<ExecutionHostId>()
  if (sourceHost) {
    declaredHosts.add(sourceHost.id)
  }
  if (executionHost && executionHost.kind !== 'runtime') {
    declaredHosts.add(executionHost.id)
  }
  if (connection.kind === 'resolved') {
    declaredHosts.add(connection.hostId)
  }
  if (declaredHosts.size > 1) {
    return { kind: 'invalid' }
  }
  const hostId = declaredHosts.values().next().value as ExecutionHostId | undefined
  return hostId ? { kind: 'resolved', hostId } : { kind: 'none' }
}

export function resolveProjectGroupPathStatusSourceHostId(
  projectGroup: PathStatusOwner
): ExecutionHostId | null {
  const resolution = resolveDeclaredSourceHostId(projectGroup)
  if (resolution.kind === 'resolved') {
    return resolution.hostId
  }
  if (resolution.kind === 'invalid') {
    return null
  }
  return parseExecutionHostId(projectGroup.executionHostId)?.kind === 'runtime'
    ? null
    : LOCAL_EXECUTION_HOST_ID
}

export function resolveFolderWorkspacePathStatusSourceHostId(
  folderWorkspace: PathStatusOwner,
  projectGroup?: PathStatusOwner | null
): ExecutionHostId | null {
  const resolution = resolveDeclaredSourceHostId(folderWorkspace)
  if (resolution.kind === 'resolved') {
    return resolution.hostId
  }
  if (resolution.kind === 'invalid') {
    return null
  }
  return projectGroup ? resolveProjectGroupPathStatusSourceHostId(projectGroup) : null
}

export function resolveRepoPathStatusSourceHostId(
  repo: RepoPathStatusOwner
): ExecutionHostId | null {
  const resolution = resolveDeclaredSourceHostId(repo)
  if (resolution.kind === 'resolved') {
    return resolution.hostId
  }
  return resolution.kind === 'invalid' ? null : LOCAL_EXECUTION_HOST_ID
}

export function getProjectGroupPathStatusRequest(
  projectGroup: ProjectGroup
): FolderWorkspacePathStatusRequest {
  const executionHostId = resolveProjectGroupPathStatusSourceHostId(projectGroup)
  return {
    scope: 'project-group',
    projectGroupId: projectGroup.id,
    ...(executionHostId ? { executionHostId } : {})
  }
}

export function getFolderWorkspacePathStatusRequest(
  folderWorkspace: FolderWorkspace,
  projectGroup?: ProjectGroup | null
): FolderWorkspacePathStatusRequest {
  const executionHostId = resolveFolderWorkspacePathStatusSourceHostId(
    folderWorkspace,
    projectGroup
  )
  return {
    scope: 'folder-workspace',
    folderWorkspaceId: folderWorkspace.id,
    ...(executionHostId ? { executionHostId } : {})
  }
}

export function findFolderWorkspacePathStatusProjectGroup(
  folderWorkspace: FolderWorkspace,
  projectGroups: readonly ProjectGroup[]
): ProjectGroup | undefined {
  let candidates = projectGroups.filter((group) => group.id === folderWorkspace.projectGroupId)
  if (candidates.length <= 1) {
    return candidates[0]
  }
  const transportHostId = resolveFolderWorkspaceExecutionHostId({ folderWorkspace })
  if (transportHostId) {
    candidates = candidates.filter(
      (group) =>
        resolveFolderWorkspaceExecutionHostId({
          folderWorkspace: {},
          projectGroup: group,
          fallbackHostId: LOCAL_EXECUTION_HOST_ID
        }) === transportHostId
    )
  }
  const sourceHostId = resolveFolderWorkspacePathStatusSourceHostId(folderWorkspace)
  if (sourceHostId && candidates.length > 1) {
    candidates = candidates.filter(
      (group) => resolveProjectGroupPathStatusSourceHostId(group) === sourceHostId
    )
  }
  return candidates.length === 1 ? candidates[0] : undefined
}
