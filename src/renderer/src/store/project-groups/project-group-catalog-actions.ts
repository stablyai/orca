import type { StateCreator } from 'zustand'
import {
  projectGroupHookTrustHost,
  projectGroupHookTrustKey
} from '../../../../shared/workspace-hook-owner'
import { catalogOwnsHost } from './project-group-owner-routing'
import type { AppState } from '../types'
import { runtimeTargetForOwnerEnvironment } from '../../runtime/rpc/targets/runtime-client-target'
import type { FetchedProjectGroupCatalog } from './project-group-catalog'
import type { HostCatalogFence } from '../host-catalog/host-catalog-fence'
import type { RepoSlice } from '../repos/repo-state'
import { arrayElementsUnchanged } from '../../lib/catalog-reconciliation/catalog-identity'
import {
  claimHostCatalogFence,
  isHostCatalogFenceCurrent,
  loadRuntimeHostCatalogs
} from '../host-catalog/host-catalog-fence'
import {
  fetchProjectGroupCatalogForTarget,
  mergeFetchedProjectGroupCatalog
} from './project-group-catalog'

export function createProjectGroupCatalogActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'fetchProjectGroups' | 'fetchProjectGroupsForAllHosts'> {
  const applyCatalog = (catalog: FetchedProjectGroupCatalog, fence: HostCatalogFence): void => {
    if (!isHostCatalogFenceCurrent(get, fence)) {
      return
    }
    set((s) => {
      if (!isHostCatalogFenceCurrent(get, fence)) {
        return s
      }
      const { projectGroups } = mergeFetchedProjectGroupCatalog(catalog, s.projectGroups)
      const validHookOwners = new Set(
        projectGroups.filter((group) => group.parentPath).map(projectGroupHookTrustKey)
      )
      const retiredKeys = Object.keys(s.trustedOrcaHooks).filter((key) => {
        const host = projectGroupHookTrustHost(key)
        return host && catalogOwnsHost(catalog.hostId, host) && !validHookOwners.has(key)
      })
      if (arrayElementsUnchanged(projectGroups, s.projectGroups) && retiredKeys.length === 0) {
        return s
      }
      const trustedOrcaHooks = { ...s.trustedOrcaHooks }
      for (const key of retiredKeys) {
        delete trustedOrcaHooks[key]
      }
      return {
        projectGroups,
        trustedOrcaHooks,
        folderWorkspacePathStatuses: {}
      }
    })
  }

  return {
    fetchProjectGroups: async (options) => {
      try {
        const target = runtimeTargetForOwnerEnvironment(options.runtimeEnvironmentId)
        const fence = claimHostCatalogFence(get, 'project-groups', target)
        applyCatalog(await fetchProjectGroupCatalogForTarget(target), fence)
      } catch (err) {
        console.error('Failed to fetch project groups:', err)
        if (options.throwOnError) {
          throw err
        }
      }
    },

    // Why: startup renders an all-host sidebar; replacing groups with only the active host leaves other hosts' repos visible but ungrouped.
    fetchProjectGroupsForAllHosts: async (options) => {
      try {
        const target = { kind: 'local' as const }
        const fence = claimHostCatalogFence(get, 'project-groups', target)
        applyCatalog(await fetchProjectGroupCatalogForTarget(target), fence)
      } catch (err) {
        console.error('Failed to fetch local project groups for all-host load:', err)
      }
      if (options?.remoteHosts === 'skip') {
        return
      }
      await loadRuntimeHostCatalogs(get, 'project-groups', async (target, fence) => {
        try {
          applyCatalog(await fetchProjectGroupCatalogForTarget(target), fence)
        } catch (err) {
          console.warn(
            `Skipped project groups for runtime environment ${target.environmentId}:`,
            err
          )
        }
      })
    }
  }
}
