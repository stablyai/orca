import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { catalogOwnsHost, getProjectGroupHostId } from '../slices/project-group-owner-routing'
import type { FolderWorkspaceUpdateTicket } from '../slices/folder-workspace-update-coordinator'
import { callRuntimeRpc, type RuntimeClientTarget } from '../../runtime/runtime-rpc-client'
import type {
  FolderWorkspaceUpdateCoordinatorInstance,
  FolderWorkspaceUpdateField
} from './folder-workspace-mutations'
import {
  folderWorkspaceUpdateInvalidatesPathStatus,
  mergeFolderWorkspaceUpdateResponse
} from './folder-workspace-routing'
import { getRuntimeTargetHostId } from '../runtime-target-host'
import { mergeByIdentity, unchangedMergeSource } from '../catalog-identity'

export type FetchedFolderWorkspaceCatalog = {
  folderWorkspaces: FolderWorkspace[]
  hostId: ExecutionHostId
}

type FolderWorkspaceHostIndex = ReadonlyMap<string, ExecutionHostId | null>

function createFolderWorkspaceHostIndex(
  projectGroups: readonly ProjectGroup[]
): FolderWorkspaceHostIndex {
  const hostByGroupId = new Map<string, ExecutionHostId | null>()
  for (const group of projectGroups) {
    const hostId = getProjectGroupHostId(group)
    if (!hostByGroupId.has(group.id)) {
      hostByGroupId.set(group.id, hostId)
      continue
    }
    const existingHostId = hostByGroupId.get(group.id)
    if (existingHostId !== null && existingHostId !== hostId) {
      // Multiple copies of a group on different hosts are intentionally local/ambiguous.
      hostByGroupId.set(group.id, null)
    }
  }
  return hostByGroupId
}

function getFolderWorkspaceHostIdFromIndex(
  workspace: FolderWorkspace,
  hostByGroupId: FolderWorkspaceHostIndex
): ExecutionHostId {
  return hostByGroupId.get(workspace.projectGroupId) ?? LOCAL_EXECUTION_HOST_ID
}

function createFolderWorkspaceHostResolver(
  projectGroups: readonly ProjectGroup[]
): (workspace: FolderWorkspace) => ExecutionHostId {
  let hostByGroupId: FolderWorkspaceHostIndex | undefined
  return (workspace) => {
    const explicitHostId = parseExecutionHostId(workspace.executionHostId)?.id
    if (explicitHostId) {
      return explicitHostId
    }
    if (workspace.connectionId) {
      return toSshExecutionHostId(workspace.connectionId)
    }
    hostByGroupId ??= createFolderWorkspaceHostIndex(projectGroups)
    return getFolderWorkspaceHostIdFromIndex(workspace, hostByGroupId)
  }
}

export function getFolderWorkspaceHostId(
  workspace: FolderWorkspace,
  projectGroups: readonly ProjectGroup[]
): ExecutionHostId {
  const explicitHostId = parseExecutionHostId(workspace.executionHostId)?.id
  if (explicitHostId) {
    return explicitHostId
  }
  if (workspace.connectionId) {
    return toSshExecutionHostId(workspace.connectionId)
  }
  let matchingHostId: ExecutionHostId | undefined
  for (const group of projectGroups) {
    if (group.id !== workspace.projectGroupId) {
      continue
    }
    const hostId = getProjectGroupHostId(group)
    if (matchingHostId === undefined) {
      matchingHostId = hostId
    } else if (matchingHostId !== hostId) {
      return LOCAL_EXECUTION_HOST_ID
    }
  }
  return matchingHostId ?? LOCAL_EXECUTION_HOST_ID
}

function getFolderWorkspaceHostIdentity(
  workspace: FolderWorkspace,
  resolveHostId: (workspace: FolderWorkspace) => ExecutionHostId
): string {
  return JSON.stringify([resolveHostId(workspace), workspace.id])
}

export function getFolderWorkspaceUpdateIdentity(
  hostId: ExecutionHostId,
  folderWorkspaceId: string
): string {
  return `${hostId}\0${folderWorkspaceId}`
}

function mergeFetchedFolderWorkspacesForHost({
  previous,
  fetched,
  projectGroups,
  hostId
}: {
  previous: readonly FolderWorkspace[]
  fetched: FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  hostId: string
}): readonly FolderWorkspace[] {
  const resolveHostId = createFolderWorkspaceHostResolver(projectGroups)
  const fetchedIdentities = new Set(
    fetched.map((workspace) => getFolderWorkspaceHostIdentity(workspace, resolveHostId))
  )
  const preserved = previous.filter((workspace) => {
    const existingHostId = resolveHostId(workspace)
    return (
      !catalogOwnsHost(hostId, existingHostId) ||
      fetchedIdentities.has(getFolderWorkspaceHostIdentity(workspace, resolveHostId))
    )
  })
  return unchangedMergeSource(
    previous,
    preserved,
    mergeByIdentity(preserved, fetched, (workspace) =>
      getFolderWorkspaceHostIdentity(workspace, resolveHostId)
    )
  )
}

export function getFolderWorkspaceCatalogReplacementIdentities(
  catalog: FetchedFolderWorkspaceCatalog,
  currentFolderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[]
): Set<string> {
  const resolveHostId = createFolderWorkspaceHostResolver(projectGroups)
  const replacedIdentities = new Set(
    catalog.folderWorkspaces.map((workspace) =>
      getFolderWorkspaceUpdateIdentity(resolveHostId(workspace), workspace.id)
    )
  )
  for (const workspace of currentFolderWorkspaces) {
    const hostId = resolveHostId(workspace)
    if (catalogOwnsHost(catalog.hostId, hostId)) {
      replacedIdentities.add(getFolderWorkspaceUpdateIdentity(hostId, workspace.id))
    }
  }
  return replacedIdentities
}

export function clearRestoredFolderWorkspaceSessionOwners(
  owners: AppState['restoredRuntimeHostIdByWorkspaceSessionKey'] | undefined,
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups'>
): AppState['restoredRuntimeHostIdByWorkspaceSessionKey'] {
  const next: AppState['restoredRuntimeHostIdByWorkspaceSessionKey'] = {}
  for (const [key, hostId] of Object.entries(owners ?? {})) {
    const scope = parseWorkspaceKey(key)
    if (scope?.type !== 'folder') {
      next[key] = hostId
      continue
    }
    const workspace = state.folderWorkspaces.find((entry) => entry.id === scope.folderWorkspaceId)
    if (workspace && !state.projectGroups.some((group) => group.id === workspace.projectGroupId)) {
      // Why: ownership resolves via the project group; if that catalog is still missing, keep the restored host owner so a session write doesn't move runtime tabs local.
      next[key] = hostId
    }
  }
  return next
}

export function folderWorkspaceWithFetchedOwner(
  workspace: FolderWorkspace,
  target: RuntimeClientTarget,
  projectGroups: readonly ProjectGroup[]
): FolderWorkspace {
  return {
    ...workspace,
    executionHostId:
      target.kind === 'environment'
        ? getRuntimeTargetHostId(target)
        : getFolderWorkspaceHostId(workspace, projectGroups)
  }
}

export async function fetchFolderWorkspaceCatalogForTarget(
  target: RuntimeClientTarget,
  projectGroups: readonly ProjectGroup[]
): Promise<FetchedFolderWorkspaceCatalog> {
  const fetchedFolderWorkspaces =
    target.kind === 'local'
      ? await window.api.folderWorkspaces.list()
      : (
          await callRuntimeRpc<{ folderWorkspaces: FolderWorkspace[] }>(
            target,
            'folderWorkspace.list',
            undefined,
            { timeoutMs: 15_000, reuseRecentCompatibilityFailure: true }
          )
        ).folderWorkspaces
  let ownedFolderWorkspaces: FolderWorkspace[]
  if (target.kind === 'local') {
    const resolveHostId = createFolderWorkspaceHostResolver(projectGroups)
    ownedFolderWorkspaces = fetchedFolderWorkspaces.map((workspace) => ({
      ...workspace,
      executionHostId: resolveHostId(workspace)
    }))
  } else {
    ownedFolderWorkspaces = fetchedFolderWorkspaces.map((workspace) =>
      folderWorkspaceWithFetchedOwner(workspace, target, projectGroups)
    )
  }
  return {
    folderWorkspaces: ownedFolderWorkspaces,
    hostId: getRuntimeTargetHostId(target)
  }
}

export function mergeFetchedFolderWorkspaceCatalog(
  catalog: FetchedFolderWorkspaceCatalog,
  currentFolderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[]
): { folderWorkspaces: readonly FolderWorkspace[]; hostId: ExecutionHostId } {
  return {
    folderWorkspaces: mergeFetchedFolderWorkspacesForHost({
      previous: currentFolderWorkspaces,
      fetched: catalog.folderWorkspaces,
      projectGroups,
      hostId: catalog.hostId
    }),
    hostId: catalog.hostId
  }
}

export async function reconcileFailedFolderWorkspaceUpdate(args: {
  target: RuntimeClientTarget
  folderWorkspaceId: string
  updateIdentity: string
  ownerHostId: ExecutionHostId
  ticket: FolderWorkspaceUpdateTicket<FolderWorkspaceUpdateField>
  coordinator: FolderWorkspaceUpdateCoordinatorInstance
  set: Parameters<StateCreator<AppState>>[0]
  get: Parameters<StateCreator<AppState>>[1]
}): Promise<void> {
  try {
    const catalog = await fetchFolderWorkspaceCatalogForTarget(
      args.target,
      args.get().projectGroups
    )
    const latestFields = args.coordinator.latestFields(args.updateIdentity, args.ticket)
    if (latestFields.length === 0) {
      return
    }
    const refreshed = catalog.folderWorkspaces.find(
      (workspace) => workspace.id === args.folderWorkspaceId
    )
    args.set((state) => ({
      folderWorkspaces: refreshed
        ? state.folderWorkspaces.map((workspace) =>
            workspace.id === args.folderWorkspaceId &&
            getFolderWorkspaceHostId(workspace, state.projectGroups) === args.ownerHostId
              ? mergeFolderWorkspaceUpdateResponse(workspace, refreshed, latestFields)
              : workspace
          )
        : state.folderWorkspaces.filter(
            (workspace) =>
              workspace.id !== args.folderWorkspaceId ||
              getFolderWorkspaceHostId(workspace, state.projectGroups) !== args.ownerHostId
          ),
      ...(folderWorkspaceUpdateInvalidatesPathStatus(latestFields) || !refreshed
        ? { folderWorkspacePathStatuses: {} }
        : {})
    }))
    if (!refreshed) {
      args.get().purgeWorktreeTerminalState([folderWorkspaceKey(args.folderWorkspaceId)])
    }
  } catch (err) {
    console.warn('Failed to reconcile folder workspace after update failure:', err)
  }
}
