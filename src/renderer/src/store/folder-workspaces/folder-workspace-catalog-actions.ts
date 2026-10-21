import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
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
  const applyCatalog = (catalog: FetchedFolderWorkspaceCatalog, fence: HostCatalogFence): void => {
    if (!isHostCatalogFenceCurrent(get, fence)) {
      return
    }
    set((current) => {
      if (!isHostCatalogFenceCurrent(get, fence)) {
        return current
      }
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

      await loadRuntimeHostCatalogs(get, 'folder-workspaces', async (target, fence) => {
        try {
          applyCatalog(
            await fetchFolderWorkspaceCatalogForTarget(target, get().projectGroups),
            fence
          )
        } catch (err) {
          failed = true
          console.warn(
            `Skipped folder workspaces for runtime environment ${target.environmentId}:`,
            err
          )
        }
      })
      if (!failed) {
        set((s) => {
          // Why reuseEqualRecordMap: the cleanup rebuilds the record every refresh, and
          // reference-equality readers (live dashboard selector, popout bridge) re-run on a
          // fresh-but-equal identity, so the equal case must keep the previous one.
          const restoredRuntimeHostIdByWorkspaceSessionKey = reuseEqualRecordMap(
            s.restoredRuntimeHostIdByWorkspaceSessionKey,
            clearRestoredFolderWorkspaceSessionOwners(
              s.restoredRuntimeHostIdByWorkspaceSessionKey,
              s
            )
          )
          return restoredRuntimeHostIdByWorkspaceSessionKey ===
            s.restoredRuntimeHostIdByWorkspaceSessionKey
            ? s
            : { restoredRuntimeHostIdByWorkspaceSessionKey }
        })
      }
    }
  }
}
