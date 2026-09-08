import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { getActiveRuntimeTarget, settingsForRuntimeOwner } from '../../runtime/runtime-rpc-client'
import type { FetchedFolderWorkspaceCatalog } from './folder-workspace-catalog'
import type { HostCatalogFence } from '../host-catalog-fencing'
import type { RepoSlice } from '../repos/repo-state'
import { arrayElementsUnchanged } from '../catalog-identity'
import { claimHostCatalogFence, isHostCatalogFenceCurrent } from '../host-catalog-fencing'
import {
  clearRestoredFolderWorkspaceSessionOwners,
  fetchFolderWorkspaceCatalogForTarget,
  getFolderWorkspaceCatalogReplacementIdentities,
  mergeFetchedFolderWorkspaceCatalog
} from './folder-workspace-catalog'
import { listRuntimeEnvironmentsForAllHostLoad } from '../runtime-catalog-hosts'
import { getFolderWorkspaceUpdateCoordinator } from './folder-workspace-mutations'

export function createFolderWorkspaceCatalogActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'fetchFolderWorkspaces' | 'fetchFolderWorkspacesForAllHosts'> {
  return {
    fetchFolderWorkspaces: async (options) => {
      try {
        const folderWorkspaceUpdates = getFolderWorkspaceUpdateCoordinator(get)
        const target = getActiveRuntimeTarget(
          settingsForRuntimeOwner(get().settings, options?.runtimeEnvironmentId)
        )
        const fence = claimHostCatalogFence(get, 'folder-workspaces', target)
        const catalog = await fetchFolderWorkspaceCatalogForTarget(target, get().projectGroups)
        if (!isHostCatalogFenceCurrent(get, fence)) {
          return
        }
        set((current) => {
          if (!isHostCatalogFenceCurrent(get, fence)) {
            return current
          }
          folderWorkspaceUpdates.recordCatalogReplacement(
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
          return {
            folderWorkspaces,
            ...(arrayElementsUnchanged(folderWorkspaces, current.folderWorkspaces)
              ? {}
              : { folderWorkspacePathStatuses: {} })
          }
        })
      } catch (err) {
        console.error('Failed to fetch folder workspaces:', err)
      }
    },

    fetchFolderWorkspacesForAllHosts: async (options) => {
      const folderWorkspaceUpdates = getFolderWorkspaceUpdateCoordinator(get)
      // Why: folder workspaces are owned through their project groups; fetch groups first, then merge each host's folder slice.
      const applyCatalog = (
        catalog: FetchedFolderWorkspaceCatalog,
        fence: HostCatalogFence
      ): void => {
        if (!isHostCatalogFenceCurrent(get, fence)) {
          return
        }
        set((current) => {
          if (!isHostCatalogFenceCurrent(get, fence)) {
            return current
          }
          folderWorkspaceUpdates.recordCatalogReplacement(
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
          return {
            folderWorkspaces,
            ...(arrayElementsUnchanged(folderWorkspaces, current.folderWorkspaces)
              ? {}
              : { folderWorkspacePathStatuses: {} })
          }
        })
      }

      let failed = false
      try {
        const target = { kind: 'local' as const }
        const fence = claimHostCatalogFence(get, 'folder-workspaces', target)
        applyCatalog(await fetchFolderWorkspaceCatalogForTarget(target, get().projectGroups), fence)
      } catch (err) {
        failed = true
        console.error('Failed to fetch local folder workspaces for all-host load:', err)
      }
      if (options?.remoteHosts === 'skip') {
        return
      }

      const environments = await listRuntimeEnvironmentsForAllHostLoad()
      await Promise.all(
        environments.map(async (environment) => {
          const target = {
            kind: 'environment' as const,
            environmentId: environment.id
          }
          const fence = claimHostCatalogFence(get, 'folder-workspaces', target)
          try {
            applyCatalog(
              await fetchFolderWorkspaceCatalogForTarget(target, get().projectGroups),
              fence
            )
          } catch (err) {
            failed = true
            console.warn(
              `Skipped folder workspaces for runtime environment ${environment.id}:`,
              err
            )
          }
        })
      )
      if (!failed) {
        set((s) => ({
          restoredRuntimeHostIdByWorkspaceSessionKey: clearRestoredFolderWorkspaceSessionOwners(
            s.restoredRuntimeHostIdByWorkspaceSessionKey,
            s
          )
        }))
      }
    }
  }
}
