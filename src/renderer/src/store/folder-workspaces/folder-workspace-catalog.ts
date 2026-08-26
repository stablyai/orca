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
  const matchingHosts = new Set(
    projectGroups
      .filter((group) => group.id === workspace.projectGroupId)
      .map(getProjectGroupHostId)
  )
  return matchingHosts.size === 1
    ? ([...matchingHosts][0] as ExecutionHostId)
    : LOCAL_EXECUTION_HOST_ID
}

function getFolderWorkspaceHostIdentity(
  workspace: FolderWorkspace,
  projectGroups: readonly ProjectGroup[]
): string {
  return JSON.stringify([getFolderWorkspaceHostId(workspace, projectGroups), workspace.id])
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
  const fetchedIdentities = new Set(
    fetched.map((workspace) => getFolderWorkspaceHostIdentity(workspace, projectGroups))
  )
  const preserved = previous.filter((workspace) => {
    const existingHostId = getFolderWorkspaceHostId(workspace, projectGroups)
    return (
      !catalogOwnsHost(hostId, existingHostId) ||
      fetchedIdentities.has(getFolderWorkspaceHostIdentity(workspace, projectGroups))
    )
  })
  return unchangedMergeSource(
    previous,
    preserved,
    mergeByIdentity(preserved, fetched, (workspace) =>
      getFolderWorkspaceHostIdentity(workspace, projectGroups)
    )
  )
}

export function getFolderWorkspaceCatalogReplacementIdentities(
  catalog: FetchedFolderWorkspaceCatalog,
  currentFolderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[]
): Set<string> {
  const replacedIdentities = new Set(
    catalog.folderWorkspaces.map((workspace) =>
      getFolderWorkspaceUpdateIdentity(
        getFolderWorkspaceHostId(workspace, projectGroups),
        workspace.id
      )
    )
  )
  for (const workspace of currentFolderWorkspaces) {
    const hostId = getFolderWorkspaceHostId(workspace, projectGroups)
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
  return {
    folderWorkspaces: fetchedFolderWorkspaces.map((workspace) =>
      folderWorkspaceWithFetchedOwner(workspace, target, projectGroups)
    ),
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
