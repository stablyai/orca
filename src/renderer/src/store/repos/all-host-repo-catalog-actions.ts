import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { applyManualRepoOrder } from '../../../../shared/manual-repo-order'
import { retainValidFilterRepoIds } from '../slices/repo-filter-selection'
import { readRuntimeWorktreeVisibilitySnapshot } from '../slices/worktree-visibility-owner-settings'
import { getRepoHostIdentity } from '../slices/repo-host-identity'
import { filterSetupScriptPromptDismissalsToValidRepos } from '@/lib/setup-script-prompt'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isRemovedRuntimeHostId } from '../slices/stale-runtime-host-rows'
import type { FetchedRepoCatalog } from './repo-catalog-merge'
import type { LocalRepoCatalogFetchOutcome } from './repo-catalog-fencing'
import type { RepoSlice } from './repo-state'
import { arrayElementsUnchanged } from '../catalog-identity'
import {
  latestAllHostRepoCatalogGenerationByStore,
  startLocalRepoCatalogFetch
} from './repo-catalog-fencing'
import {
  claimHostCatalogFence,
  isHostCatalogFenceCurrent,
  loadRuntimeHostCatalogs,
  type HostCatalogFence
} from '../host-catalog-fencing'
import {
  fetchRepoCatalogForTarget,
  filterSetupsForPrunedRepoRows,
  filterTrustedOrcaHooksToValidRepos,
  mergeFetchedRepoCatalog,
  reconcileFetchedCatalogWorktreeState,
  reconcileSupersededSshRepos
} from './repo-catalog-merge'
import { getRuntimeTargetHostId } from '../../runtime/runtime-client-target'
import { mergeFetchedHostProjectCatalog } from '../../../../shared/project-compatibility-host-merge'
import { scheduleSafeAutoForkSync } from './safe-auto-fork-sync'

export function createAllHostRepoCatalogActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'fetchReposForAllHosts'> {
  return {
    fetchReposForAllHosts: async (options) => {
      const hostRefreshes: Promise<void>[] = []
      const settleLocalCatalog = startLocalRepoCatalogFetch(get)
      let generation = 0
      set((s) => {
        generation = s.reposFetchGeneration + 1
        return { reposFetchGeneration: generation }
      })
      latestAllHostRepoCatalogGenerationByStore.set(get, generation)
      const isCurrent = (fence: HostCatalogFence): boolean =>
        latestAllHostRepoCatalogGenerationByStore.get(get) === generation &&
        isHostCatalogFenceCurrent(get, fence)
      // Load local/all runtime catalogs fail-soft or all-host sidebars lose projects from unfocused hosts.
      const applyCatalog = (catalog: FetchedRepoCatalog, fence: HostCatalogFence): boolean => {
        // Why: a concurrent refresh or a replaced connection must not let an older catalog resurrect a migrated SSH owner.
        if (!isCurrent(fence)) {
          return false
        }
        let hostRepos: Repo[] = []
        set((s) => {
          // Why: skip a catalog whose env was tombstoned mid-load (removed), not one merely absent from the not-yet-hydrated saved list (#8881).
          if (isRemovedRuntimeHostId(catalog.hostId, s.removedRuntimeEnvironmentIds)) {
            return s
          }
          const result = mergeFetchedRepoCatalog(catalog, s.repos)
          const reconciliation = reconcileSupersededSshRepos(result.repos, s)
          const finalizedRepos = applyManualRepoOrder(reconciliation.repos, s.manualRepoOrder)
          const mergedProjectCompatibility = mergeFetchedHostProjectCatalog({
            previous: {
              projects: s.endpointProjects,
              projectHostSetups: filterSetupsForPrunedRepoRows(
                s.endpointProjectHostSetups,
                result.repos,
                finalizedRepos
              )
            },
            fetched: catalog.projectHostSetupCompatibility,
            repos: finalizedRepos,
            hostId: result.hostId
          })
          hostRepos = finalizedRepos.filter(
            (repo) => getRepoExecutionHostId(repo) === result.hostId
          )
          return {
            repos: finalizedRepos,
            pendingSshRepoReadoptions: reconciliation.pendingReadoptions,
            ...reconcileFetchedCatalogWorktreeState(s, catalog, finalizedRepos),
            endpointProjects: mergedProjectCompatibility.projects,
            endpointProjectHostSetups: mergedProjectCompatibility.projectHostSetups,
            ...(arrayElementsUnchanged(finalizedRepos, s.repos)
              ? {}
              : { folderWorkspacePathStatuses: {} }),
            activeRepoId: s.activeRepoId,
            filterRepoIds: s.filterRepoIds,
            setupScriptPromptDismissedRepoIds: s.setupScriptPromptDismissedRepoIds
          }
        })
        // Why: keep the safe-auto fork sync (as fetchRepos does) so cold-start, which now routes here, still updates safe-auto forks.
        scheduleSafeAutoForkSync(hostRepos)
        if (options?.onHostLoaded) {
          const onHostLoaded = options.onHostLoaded
          hostRefreshes.push(
            Promise.resolve()
              .then(async () => {
                if (isCurrent(fence)) {
                  await onHostLoaded(catalog.hostId)
                }
              })
              .catch((err: unknown) => {
                console.warn(`Failed to refresh worktrees for host ${catalog.hostId}:`, err)
              })
          )
        }
        return true
      }
      const validateRepoScopedUi = (): void => {
        set((s) => {
          const validRepoIds = new Set(s.repos.map((repo) => repo.id))
          const validRepoHostIdentities = new Set(s.repos.map(getRepoHostIdentity))
          return {
            activeRepoId:
              s.activeRepoId && validRepoIds.has(s.activeRepoId) ? s.activeRepoId : null,
            filterRepoIds: retainValidFilterRepoIds(s.filterRepoIds, validRepoIds),
            setupScriptPromptDismissedRepoIds: filterSetupScriptPromptDismissalsToValidRepos(
              s.setupScriptPromptDismissedRepoIds,
              validRepoHostIdentities
            ),
            trustedOrcaHooks: filterTrustedOrcaHooksToValidRepos(s.trustedOrcaHooks, validRepoIds)
          }
        })
      }

      // Local first so local repos are present even if a remote fetch stalls.
      let failed = false
      let localCatalogOutcome: LocalRepoCatalogFetchOutcome = { status: 'fulfilled' }
      const localFence = claimHostCatalogFence(get, 'repos', { kind: 'local' })
      try {
        if (
          !applyCatalog(await fetchRepoCatalogForTarget({ kind: 'local' }, get().repos), localFence)
        ) {
          failed = true
        }
      } catch (err) {
        failed = true
        localCatalogOutcome = { status: 'rejected', reason: err }
        console.error('Failed to fetch local repos for all-host load:', err)
      }
      // Why: startup hydration needs the newest local catalog, not unreachable remote hosts.
      settleLocalCatalog(localCatalogOutcome)
      // Why: a newer local-only refresh must not cancel this load's unrelated remote catalogs.
      if (latestAllHostRepoCatalogGenerationByStore.get(get) !== generation) {
        await Promise.all(hostRefreshes)
        return
      }
      if (options?.remoteHosts === 'skip') {
        await Promise.all(hostRefreshes)
        return
      }

      // Merge hosts as they resolve; unreachable peers can wait a full timeout and parallel loads must not clobber.
      await loadRuntimeHostCatalogs(
        get,
        'repos',
        async (target, fence) => {
          const [catalogResult, visibilitySnapshot] = await Promise.all([
            fetchRepoCatalogForTarget(target, get().repos).then(
              (catalog) => ({ ok: true as const, catalog }),
              (error: unknown) => ({ ok: false as const, error })
            ),
            readRuntimeWorktreeVisibilitySnapshot(target.environmentId)
          ])
          const visibilityDefaults = visibilitySnapshot.defaults
          const hostId = getRuntimeTargetHostId(target)
          if (visibilityDefaults !== undefined && isCurrent(fence)) {
            set((state) =>
              isRemovedRuntimeHostId(hostId, state.removedRuntimeEnvironmentIds)
                ? state
                : {
                    worktreeVisibilityDefaultsByHost: {
                      ...state.worktreeVisibilityDefaultsByHost,
                      [hostId]: visibilityDefaults
                    },
                    // Why: the settings page mirrors only the default host's source-defaults support.
                    ...(state.settings?.activeRuntimeEnvironmentId === target.environmentId
                      ? {
                          worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId:
                            visibilitySnapshot.sourceDefaultsSupported ? target.environmentId : null
                        }
                      : {})
                  }
            )
          }
          if (catalogResult.ok) {
            if (!applyCatalog(catalogResult.catalog, fence)) {
              failed = true
            }
          } else {
            failed = true
            console.warn(
              `Skipped repos for runtime environment ${target.environmentId}:`,
              catalogResult.error
            )
          }
        },
        () => latestAllHostRepoCatalogGenerationByStore.get(get) === generation
      )
      await Promise.all(hostRefreshes)
      // Validate saved repo UI only after all hosts answer; local-first paint otherwise erases offline-runtime filters.
      if (!failed && get().reposFetchGeneration === generation) {
        validateRepoScopedUi()
      }
    }
  }
}
