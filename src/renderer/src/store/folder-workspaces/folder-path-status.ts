import type { AppState } from '../types'
import { FOLDER_WORKSPACE_PATH_STATUS_TTL_MS } from '../../../../shared/folder-workspace-path-status'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../../../shared/folder-workspace-path-status'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type {
  FolderWorkspacePathStatusCacheEntry,
  FolderWorkspacePathStatusRouteOptions
} from '../repos/repo-state'
import {
  getRuntimeTargetHostId,
  runtimeTargetForOwnerEnvironment
} from '../../runtime/runtime-client-target'
import { catalogOwnsHost, getProjectGroupHostId } from '../slices/project-group-owner-routing'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspace-execution-host'
import { selectFolderWorkspaces } from '../workspace-record-selectors'

type FolderPathStatusSnapshotState = Pick<
  AppState,
  'projectGroups' | 'folderWorkspaces' | 'repos' | 'sshConnectionStates'
>

type FolderPathStatusScope = {
  path: string
  projectGroupId: string | null
  connectionId: string | null
  executionHostId: ExecutionHostId
}

function getFolderPathStatusScope(
  state: FolderPathStatusSnapshotState,
  request: FolderWorkspacePathStatusRequest,
  ownerHostId: ExecutionHostId
): FolderPathStatusScope | null {
  if (request.scope === 'path') {
    return {
      path: request.path,
      projectGroupId: null,
      connectionId: request.connectionId ?? null,
      executionHostId: ownerHostId
    }
  }
  if (request.scope === 'project-group') {
    const groups = state.projectGroups.filter(
      (group) =>
        group.id === request.projectGroupId &&
        catalogOwnsHost(ownerHostId, getProjectGroupHostId(group))
    )
    const group = groups.length === 1 ? groups[0] : null
    return group?.parentPath
      ? {
          path: group.parentPath,
          projectGroupId: group.id,
          connectionId: group.connectionId ?? null,
          executionHostId: getProjectGroupHostId(group)
        }
      : null
  }
  const folders = selectFolderWorkspaces(state).filter(
    (workspace) =>
      workspace.id === request.folderWorkspaceId &&
      catalogOwnsHost(ownerHostId, getFolderWorkspaceHostId(workspace, state.projectGroups))
  )
  const folder = folders.length === 1 ? folders[0] : null
  if (!folder?.folderPath || !folder.projectGroupId) {
    return null
  }
  const executionHostId = getFolderWorkspaceHostId(folder, state.projectGroups)
  const group = state.projectGroups.find(
    (candidate) =>
      candidate.id === folder.projectGroupId && getProjectGroupHostId(candidate) === executionHostId
  )
  return {
    path: folder.folderPath,
    projectGroupId: folder.projectGroupId,
    connectionId: folder.connectionId ?? group?.connectionId ?? null,
    executionHostId
  }
}

export function getFolderWorkspaceStatusRequestSnapshot(
  state: FolderPathStatusSnapshotState,
  request: FolderWorkspacePathStatusRequest,
  options: FolderWorkspacePathStatusRouteOptions
): string | null {
  const ownerHostId = getRuntimeTargetHostId(
    runtimeTargetForOwnerEnvironment(options.runtimeEnvironmentId)
  )
  const scope = getFolderPathStatusScope(state, request, ownerHostId)
  if (!scope) {
    return null
  }
  const projectGroups = state.projectGroups.filter((group) =>
    catalogOwnsHost(ownerHostId, getProjectGroupHostId(group))
  )
  const groupIds = scope.projectGroupId
    ? getProjectGroupSubtreeIds(projectGroups, scope.projectGroupId)
    : new Set<string>()
  const candidateRepos = state.repos.filter(
    (repo) =>
      catalogOwnsHost(ownerHostId, getRepoExecutionHostId(repo)) &&
      ((typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) ||
        isPathInsideOrEqual(scope.path, repo.path))
  )
  const relevantConnectionIds = new Set<string>()
  if (scope.connectionId) {
    relevantConnectionIds.add(scope.connectionId)
  }
  for (const repo of candidateRepos) {
    if (repo.connectionId) {
      relevantConnectionIds.add(repo.connectionId)
    }
  }
  const sshFingerprint = [...relevantConnectionIds]
    .map(
      (connectionId) =>
        `${connectionId}:${state.sshConnectionStates.get(connectionId)?.status ?? 'missing'}`
    )
    .sort()
    .join('|')
  const repoFingerprint = candidateRepos
    .map(
      (repo) =>
        `${repo.id}:${repo.path}:${repo.projectGroupId ?? ''}:${repo.connectionId ?? ''}:${getRepoExecutionHostId(repo)}`
    )
    .sort()
    .join('|')
  return [
    scope.path,
    scope.projectGroupId ?? '',
    scope.connectionId ?? '',
    scope.executionHostId,
    sshFingerprint,
    repoFingerprint
  ].join('\0')
}

export function getFreshFolderWorkspacePathStatusFromCache(args: {
  entry: FolderWorkspacePathStatusCacheEntry | undefined
  requestSnapshot: string | null
}): FolderWorkspacePathStatus | null {
  const { entry, requestSnapshot } = args
  if (!entry || requestSnapshot === null || entry.requestSnapshot !== requestSnapshot) {
    return null
  }
  return Date.now() - entry.checkedAt < FOLDER_WORKSPACE_PATH_STATUS_TTL_MS ? entry.status : null
}
