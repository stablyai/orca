import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { FolderWorkspacePathStatusRequest } from '../../../../shared/folder-workspace-path-status'
import {
  runtimeTargetForOwnerEnvironment,
  type RuntimeClientTarget
} from '../../runtime/runtime-client-target'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
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

export function getPathStatusOwnerCachePrefix(
  owner: FolderWorkspacePathStatusRouteOptions
): string {
  const target = runtimeTargetForOwnerEnvironment(owner.runtimeEnvironmentId)
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
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
    if (field === 'linkedItemsBase' || field === 'linkedItemsSelectionChanged') {
      continue
    }
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

/** The folder workspace's owner, or `null` when its rows name none or disagree. */
export function folderWorkspaceOwnerTarget(
  state: WorktreeOperationRouteState,
  folderWorkspaceId: string,
  executionHostId: ExecutionHostId | null | undefined
): RuntimeClientTarget | null {
  return runtimeTargetForWorkspaceOwner(state, {
    workspaceId: folderWorkspaceKey(folderWorkspaceId),
    ...(executionHostId ? { hostId: executionHostId } : {})
  })
}
