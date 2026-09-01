import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { FolderWorkspacePathStatusRequest } from '../../../../shared/folder-workspace-path-status'
import { getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import type { FolderWorkspacePathStatusRouteOptions } from '../repos/repo-state'
import type { FolderWorkspaceUpdateField } from './folder-workspace-mutations'

export function getFolderWorkspacePathStatusScopeKey(
  request: FolderWorkspacePathStatusRequest
): string {
  if (request.scope === 'project-group') {
    return `project-group:${request.projectGroupId}`
  }
  if (request.scope === 'path') {
    return `path:${request.connectionId ?? ''}:${request.path}`
  }
  return `folder-workspace:${request.folderWorkspaceId}`
}

export function getRuntimeTargetCachePrefix(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): string {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

export function getFolderWorkspacePathStatusRouteSettings(
  options: FolderWorkspacePathStatusRouteOptions | undefined,
  fallbackSettings: GlobalSettings | null
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined {
  return options && 'runtimeEnvironmentId' in options
    ? { activeRuntimeEnvironmentId: options.runtimeEnvironmentId ?? null }
    : fallbackSettings
}

export function folderWorkspaceUpdateInvalidatesPathStatus(
  fields: readonly FolderWorkspaceUpdateField[]
): boolean {
  return fields.includes('folderPath')
}

export function mergeFolderWorkspaceUpdateResponse(
  current: FolderWorkspace,
  updated: FolderWorkspace,
  fields: readonly FolderWorkspaceUpdateField[],
  options: { rejectOlderResponse?: boolean } = {}
): FolderWorkspace {
  if (
    fields.length === 0 ||
    (options.rejectOlderResponse && updated.updatedAt < current.updatedAt)
  ) {
    return current
  }
  const next = { ...current }
  for (const field of fields) {
    // Why: coalesced activity can land an older response after later local bumps.
    if (field === 'lastActivityAt') {
      next.lastActivityAt = Math.max(current.lastActivityAt, updated.lastActivityAt)
      continue
    }
    Object.assign(next, { [field]: updated[field] })
  }
  next.updatedAt = Math.max(current.updatedAt, updated.updatedAt)
  return next
}
