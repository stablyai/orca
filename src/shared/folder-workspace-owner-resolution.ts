import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { FolderWorkspace, ProjectGroup } from './types'

export type DeclaredFolderScopeOwner =
  | { status: 'owned'; executionHostId: ExecutionHostId }
  | { status: 'unknown' | 'invalid' }

export type DirectFolderScopeAuthority =
  | { status: 'direct'; connectionId: string | null }
  | { status: 'unknown' | 'invalid' }

export function resolveDeclaredFolderScopeOwner(
  scope: Pick<FolderWorkspace | ProjectGroup, 'connectionId' | 'executionHostId'>
): DeclaredFolderScopeOwner {
  const hasExecutionHostId = scope.executionHostId !== null && scope.executionHostId !== undefined
  const explicitHost = hasExecutionHostId ? parseExecutionHostId(scope.executionHostId) : null
  if (hasExecutionHostId && !explicitHost) {
    return { status: 'invalid' }
  }
  if (scope.connectionId !== undefined) {
    const connectionId = scope.connectionId?.trim()
    if (scope.connectionId !== null && !connectionId) {
      return { status: 'invalid' }
    }
    const connectionHostId = connectionId
      ? toSshExecutionHostId(connectionId)
      : LOCAL_EXECUTION_HOST_ID
    return explicitHost && explicitHost.id !== connectionHostId
      ? { status: 'invalid' }
      : { status: 'owned', executionHostId: connectionHostId }
  }
  return explicitHost
    ? { status: 'owned', executionHostId: explicitHost.id }
    : { status: 'unknown' }
}

export function resolveProjectGroupOwner(group: ProjectGroup): DeclaredFolderScopeOwner {
  const owner = resolveDeclaredFolderScopeOwner(group)
  return owner.status === 'unknown'
    ? { status: 'owned', executionHostId: LOCAL_EXECUTION_HOST_ID }
    : owner
}

export function resolveProjectGroupDirectAuthority(
  group: ProjectGroup
): DirectFolderScopeAuthority {
  return toDirectFolderScopeAuthority(resolveProjectGroupOwner(group))
}

export function resolveDirectFolderScopeAuthority(
  scope: Pick<FolderWorkspace | ProjectGroup, 'connectionId' | 'executionHostId'>
): DirectFolderScopeAuthority {
  return toDirectFolderScopeAuthority(resolveDeclaredFolderScopeOwner(scope))
}

function toDirectFolderScopeAuthority(owner: DeclaredFolderScopeOwner): DirectFolderScopeAuthority {
  if (owner.status !== 'owned') {
    return owner
  }
  const parsedOwner = parseExecutionHostId(owner.executionHostId)
  if (parsedOwner?.kind === 'local') {
    return { status: 'direct', connectionId: null }
  }
  return parsedOwner?.kind === 'ssh'
    ? { status: 'direct', connectionId: parsedOwner.targetId }
    : { status: 'invalid' }
}

export function resolveFolderWorkspaceOwner(
  workspace: FolderWorkspace,
  projectGroups: readonly ProjectGroup[]
): DeclaredFolderScopeOwner {
  const workspaceOwner = resolveDeclaredFolderScopeOwner(workspace)
  if (workspaceOwner.status !== 'unknown') {
    return workspaceOwner
  }
  const groups = projectGroups.filter((group) => group.id === workspace.projectGroupId)
  const groupOwners = groups.map(resolveProjectGroupOwner)
  if (groupOwners.some((owner) => owner.status === 'invalid')) {
    return { status: 'invalid' }
  }
  const localOwners = groupOwners.filter(
    (owner) => owner.status === 'owned' && owner.executionHostId === LOCAL_EXECUTION_HOST_ID
  )
  if (localOwners.length > 0) {
    return localOwners.length === 1
      ? { status: 'owned', executionHostId: LOCAL_EXECUTION_HOST_ID }
      : { status: 'invalid' }
  }
  if (groups.length === 0) {
    return { status: 'owned', executionHostId: LOCAL_EXECUTION_HOST_ID }
  }
  return groups.length === 1 ? groupOwners[0] : { status: 'invalid' }
}

export function resolveFolderWorkspaceDirectAuthority(
  workspace: FolderWorkspace,
  groups: readonly ProjectGroup[]
): DirectFolderScopeAuthority {
  return toDirectFolderScopeAuthority(resolveFolderWorkspaceOwner(workspace, groups))
}

export function findFolderWorkspaceForExecutionHost(args: {
  folderWorkspaceId: string
  executionHostId: ExecutionHostId
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
}): FolderWorkspace | undefined {
  const matches = args.folderWorkspaces.filter((workspace) => {
    if (workspace.id !== args.folderWorkspaceId) {
      return false
    }
    const owner = resolveFolderWorkspaceOwner(workspace, args.projectGroups)
    return owner.status === 'owned' && owner.executionHostId === args.executionHostId
  })
  return matches.length === 1 ? matches[0] : undefined
}
