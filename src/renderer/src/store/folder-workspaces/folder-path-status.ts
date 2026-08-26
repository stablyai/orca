import type { AppState } from '../types'
import { FOLDER_WORKSPACE_PATH_STATUS_TTL_MS } from '../../../../shared/folder-workspace-path-status'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../../../shared/folder-workspace-path-status'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import type { FolderWorkspacePathStatusCacheEntry } from '../repos/repo-state'

export function getFolderWorkspaceStatusRequestSnapshot(
  state: Pick<AppState, 'projectGroups' | 'folderWorkspaces' | 'repos' | 'sshConnectionStates'>,
  request: FolderWorkspacePathStatusRequest
): string | null {
  if (request.scope === 'path') {
    const candidateRepos = state.repos.filter((repo) =>
      isPathInsideOrEqual(request.path, repo.path)
    )
    const relevantConnectionIds = new Set<string>()
    if (request.connectionId) {
      relevantConnectionIds.add(request.connectionId)
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
        (repo) => `${repo.id}:${repo.path}:${repo.projectGroupId ?? ''}:${repo.connectionId ?? ''}`
      )
      .sort()
      .join('|')
    return [request.path, '', request.connectionId ?? '', sshFingerprint, repoFingerprint].join(
      '\0'
    )
  }

  const scope =
    request.scope === 'project-group'
      ? state.projectGroups.find((group) => group.id === request.projectGroupId)
      : state.folderWorkspaces.find((workspace) => workspace.id === request.folderWorkspaceId)
  const projectGroup =
    request.scope === 'project-group'
      ? scope && 'parentPath' in scope
        ? scope
        : null
      : scope && 'projectGroupId' in scope
        ? state.projectGroups.find((group) => group.id === scope.projectGroupId)
        : null
  const folderPath =
    request.scope === 'project-group'
      ? scope && 'parentPath' in scope
        ? scope.parentPath
        : null
      : scope && 'folderPath' in scope
        ? scope.folderPath
        : null
  const projectGroupId =
    request.scope === 'project-group'
      ? request.projectGroupId
      : scope && 'projectGroupId' in scope
        ? scope.projectGroupId
        : null
  const scopeConnectionId =
    request.scope === 'project-group'
      ? scope && 'parentPath' in scope
        ? scope.connectionId
        : null
      : scope && 'folderPath' in scope
        ? (scope.connectionId ?? projectGroup?.connectionId)
        : null
  if (!folderPath || !projectGroupId) {
    return null
  }
  const groupIds = getProjectGroupSubtreeIds(state.projectGroups, projectGroupId)
  const candidateRepos = state.repos.filter(
    (repo) =>
      (typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) ||
      isPathInsideOrEqual(folderPath, repo.path)
  )
  const relevantConnectionIds = new Set<string>()
  if (scopeConnectionId) {
    relevantConnectionIds.add(scopeConnectionId)
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
      (repo) => `${repo.id}:${repo.path}:${repo.projectGroupId ?? ''}:${repo.connectionId ?? ''}`
    )
    .sort()
    .join('|')
  return [
    folderPath,
    projectGroupId,
    scopeConnectionId ?? '',
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

export function getFolderWorkspacePathStatusRequestSnapshotForRead(
  state: AppState,
  request: FolderWorkspacePathStatusRequest
): string | null {
  return getFolderWorkspaceStatusRequestSnapshot(state, request)
}
