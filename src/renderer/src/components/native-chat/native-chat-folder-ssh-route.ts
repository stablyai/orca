import type { AppState } from '../../store/types'
import {
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

type FolderSshRouteState = Pick<
  AppState,
  'activeWorkspaceExecutionHostId' | 'activeWorktreeId' | 'folderWorkspaces' | 'projectGroups'
>

export type NativeChatFolderSshRouteResolution =
  | {
      kind: 'resolved'
      hostId: ExecutionHostId
      targetId: string
      environmentId: string | null
    }
  | { kind: 'ambiguous' }
  | { kind: 'non-ssh'; ownerHostId: ExecutionHostId | null }
  | { kind: 'missing'; ownerHostId?: ExecutionHostId | null }

type FolderSshRoute = Extract<NativeChatFolderSshRouteResolution, { kind: 'resolved' }>

export function resolveNativeChatFolderSshRoute(
  state: FolderSshRouteState,
  folderWorkspaceId: string
): NativeChatFolderSshRouteResolution {
  const routes = new Map<string, FolderSshRoute>()
  const nonSshOwnerHostIds: (ExecutionHostId | null)[] = []
  const unresolvedOwnerHostIds: (ExecutionHostId | null)[] = []
  const activeHost =
    state.activeWorktreeId === folderWorkspaceKey(folderWorkspaceId)
      ? parseExecutionHostId(state.activeWorkspaceExecutionHostId)
      : null
  const workspaces = state.folderWorkspaces.filter(
    (workspace) => workspace.id === folderWorkspaceId
  )
  for (const workspace of workspaces) {
    const workspaceHost = parseExecutionHostId(workspace.executionHostId)
    const groups = state.projectGroups.filter((group) => {
      if (group.id !== workspace.projectGroupId) {
        return false
      }
      const groupHost = parseExecutionHostId(group.executionHostId)
      return !workspaceHost || !groupHost || workspaceHost.id === groupHost.id
    })
    for (const group of groups.length > 0 ? groups : [null]) {
      const route = routeForFolderOwners(workspace, group)
      if (route.kind === 'ambiguous') {
        return route
      }
      if (route.kind === 'resolved') {
        routes.set(JSON.stringify([route.hostId, route.environmentId]), route)
      } else if (!group) {
        unresolvedOwnerHostIds.push(route.ownerHostId ?? null)
      } else if (route.kind === 'non-ssh') {
        nonSshOwnerHostIds.push(route.ownerHostId)
      } else {
        unresolvedOwnerHostIds.push(route.ownerHostId ?? null)
      }
    }
  }
  const candidates = [...routes.values()].filter((route) => {
    if (!activeHost) {
      return true
    }
    return activeHost.kind === 'ssh'
      ? activeHost.id === route.hostId
      : activeHost.kind === 'runtime'
        ? activeHost.environmentId === route.environmentId
        : false
  })
  const ownerMatchesActiveHost = (ownerHostId: ExecutionHostId | null): boolean =>
    !activeHost || !ownerHostId || ownerHostId === activeHost.id
  const relevantNonSshOwnerHostIds = nonSshOwnerHostIds.filter(ownerMatchesActiveHost)
  const relevantUnresolvedOwnerHostIds = unresolvedOwnerHostIds.filter(ownerMatchesActiveHost)
  const evidenceCount = routes.size + nonSshOwnerHostIds.length + unresolvedOwnerHostIds.length
  if (
    activeHost &&
    candidates.length === 0 &&
    relevantNonSshOwnerHostIds.length === 0 &&
    relevantUnresolvedOwnerHostIds.length === 0 &&
    evidenceCount > 0
  ) {
    return { kind: 'ambiguous' }
  }
  if (candidates.length > 0) {
    return candidates.length === 1 &&
      relevantNonSshOwnerHostIds.length === 0 &&
      relevantUnresolvedOwnerHostIds.length === 0
      ? candidates[0]
      : { kind: 'ambiguous' }
  }
  if (relevantUnresolvedOwnerHostIds.length > 0) {
    return { kind: 'missing' }
  }
  if (relevantNonSshOwnerHostIds.length === 1) {
    return { kind: 'non-ssh', ownerHostId: relevantNonSshOwnerHostIds[0] ?? null }
  }
  return relevantNonSshOwnerHostIds.length > 1 ? { kind: 'ambiguous' } : { kind: 'missing' }
}

function routeForFolderOwners(
  workspace: FolderSshRouteState['folderWorkspaces'][number],
  group: FolderSshRouteState['projectGroups'][number] | null
): NativeChatFolderSshRouteResolution {
  const workspaceHost = parseExecutionHostId(workspace.executionHostId)
  const groupHost = parseExecutionHostId(group?.executionHostId)
  if (
    (workspace.executionHostId !== null &&
      workspace.executionHostId !== undefined &&
      !workspaceHost) ||
    (group?.executionHostId !== null && group?.executionHostId !== undefined && !groupHost) ||
    (workspace.connectionId !== null &&
      workspace.connectionId !== undefined &&
      !workspace.connectionId.trim()) ||
    (group?.connectionId !== null &&
      group?.connectionId !== undefined &&
      !group.connectionId.trim())
  ) {
    return { kind: 'ambiguous' }
  }
  if (workspaceHost && groupHost && workspaceHost.id !== groupHost.id) {
    return { kind: 'missing', ownerHostId: workspaceHost.id }
  }
  const logicalHost = workspaceHost ?? groupHost
  const connectionIds = new Set(
    [workspace.connectionId?.trim(), group?.connectionId?.trim()].filter(
      (connectionId): connectionId is string => Boolean(connectionId)
    )
  )
  if (connectionIds.size > 1 || (logicalHost?.kind === 'local' && connectionIds.size > 0)) {
    return { kind: 'ambiguous' }
  }
  const connectionId = connectionIds.values().next().value
  let hostId = connectionId ? toSshExecutionHostId(connectionId) : null
  if (logicalHost?.kind === 'ssh') {
    if (hostId && hostId !== logicalHost.id) {
      return { kind: 'ambiguous' }
    }
    hostId = logicalHost.id
  }
  if (!hostId) {
    return { kind: 'non-ssh', ownerHostId: logicalHost?.id ?? null }
  }
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'ssh') {
    return { kind: 'missing', ownerHostId: logicalHost?.id ?? null }
  }
  return {
    kind: 'resolved',
    hostId: host.id,
    targetId: host.targetId,
    environmentId: logicalHost?.kind === 'runtime' ? logicalHost.environmentId : null
  }
}
