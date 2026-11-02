import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { runtimeTargetForOwnerEnvironment } from '../../runtime/runtime-client-target'
import type { FetchedFolderWorkspaceCatalog } from './folder-workspace-catalog'
import type { HostCatalogFence } from '../host-catalog-fencing'
import type { RepoSlice } from '../repos/repo-state'
import { arrayElementsUnchanged } from '../catalog-identity'
import {
  claimHostCatalogFence,
  isHostCatalogFenceCurrent,
  loadRuntimeHostCatalogs
} from '../host-catalog-fencing'
import {
  clearRestoredFolderWorkspaceSessionOwners,
  fetchFolderWorkspaceCatalogForTarget,
  getFolderWorkspaceCatalogReplacementIdentities,
  mergeFetchedFolderWorkspaceCatalog
} from './folder-workspace-catalog'
import { reuseEqualRecordMap } from '../slices/repo-identity-reconcile'
import { getFolderWorkspaceUpdateCoordinator } from './folder-workspace-mutations'

export function createFolderWorkspaceCatalogActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'fetchFolderWorkspaces' | 'fetchFolderWorkspacesForAllHosts'> {
  // Why: folder workspaces are owned through their project groups; merge each host's folder slice against them.
  const applyCatalog = (
    catalog: FetchedFolderWorkspaceCatalog,
    fence: HostCatalogFence
  ): boolean => {
    if (!isHostCatalogFenceCurrent(get, fence)) {
      return false
    }
    let applied = false
    set((current) => {
      if (!isHostCatalogFenceCurrent(get, fence)) {
        return current
      }
      applied = true
      getFolderWorkspaceUpdateCoordinator(get).recordCatalogReplacement(
        getFolderWorkspaceCatalogReplacementIdentities(
          catalog,
          current.folderWorkspaces,
          current.projectGroups
        )
      )
      const { folderWorkspaces } = mergeFetchedFolderWorkspaceCatalog(
        catalog,
        current.folderWorkspaces,
        current.projectGroups
      )
      if (arrayElementsUnchanged(folderWorkspaces, current.folderWorkspaces)) {
        return current
      }
      return {
        folderWorkspaces,
        folderWorkspacePathStatuses: {}
      }
    })
    return applied
  }

  return {
    fetchFolderWorkspaces: async (options) => {
      try {
        const target = runtimeTargetForOwnerEnvironment(options.runtimeEnvironmentId)
        const fence = claimHostCatalogFence(get, 'folder-workspaces', target)
        applyCatalog(await fetchFolderWorkspaceCatalogForTarget(target, get().projectGroups), fence)
      } catch (err) {
        console.error('Failed to fetch folder workspaces:', err)
        if (options.throwOnError) {
          throw err
        }
      }
    },

    fetchFolderWorkspacesForAllHosts: async (options) => {
      const hydratedFolderWorkspaceFences = new Map<ExecutionHostId, HostCatalogFence>()
      let listedRuntimeHostIds: ReadonlySet<ExecutionHostId> | null = null
      const localTarget = { kind: 'local' as const }
      const localFence = claimHostCatalogFence(get, 'folder-workspaces', localTarget)
      const clearRestoredOwnersForHydratedHosts = (): void => {
        const hydratedFolderWorkspaceHostIds = new Set(
          [...hydratedFolderWorkspaceFences]
            .filter(([, fence]) => isHostCatalogFenceCurrent(get, fence))
            .map(([hostId]) => hostId)
        )
        set((s) => {
          const restoredRuntimeHostIdByWorkspaceSessionKey = reuseEqualRecordMap(
            s.restoredRuntimeHostIdByWorkspaceSessionKey,
            clearRestoredFolderWorkspaceSessionOwners(
              s.restoredRuntimeHostIdByWorkspaceSessionKey,
              s,
              {
                hydratedHostIds: hydratedFolderWorkspaceHostIds,
                // A newer load re-claims the local fence; this load's env list is stale then.
                listedRuntimeHostIds: isHostCatalogFenceCurrent(get, localFence)
                  ? listedRuntimeHostIds
                  : null
              }
            )
          )
          return restoredRuntimeHostIdByWorkspaceSessionKey ===
            s.restoredRuntimeHostIdByWorkspaceSessionKey
            ? s
            : { restoredRuntimeHostIdByWorkspaceSessionKey }
        })
      }
      try {
        const catalog = await fetchFolderWorkspaceCatalogForTarget(localTarget, get().projectGroups)
        if (applyCatalog(catalog, localFence)) {
          hydratedFolderWorkspaceFences.set(catalog.hostId, localFence)
        }
      } catch (err) {
        console.error('Failed to fetch local folder workspaces for all-host load:', err)
      }
      if (options?.remoteHosts === 'skip') {
        clearRestoredOwnersForHydratedHosts()
        return
      }

      await loadRuntimeHostCatalogs(
        get,
        'folder-workspaces',
        async (target, fence) => {
          try {
            const catalog = await fetchFolderWorkspaceCatalogForTarget(target, get().projectGroups)
            if (applyCatalog(catalog, fence)) {
              hydratedFolderWorkspaceFences.set(catalog.hostId, fence)
            }
          } catch (err) {
            console.warn(
              `Skipped folder workspaces for runtime environment ${target.environmentId}:`,
              err
            )
          }
        },
        undefined,
        (environmentIds) => {
          listedRuntimeHostIds = new Set(environmentIds.map(toRuntimeExecutionHostId))
        }
      )
      clearRestoredOwnersForHydratedHosts()
    }
  }
}
