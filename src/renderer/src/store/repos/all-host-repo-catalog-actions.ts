import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { applyManualRepoOrder } from '../../../../shared/manual-repo-order'
import { retainValidFilterRepoIds } from '../slices/repo-filter-selection'
import { readRuntimeWorktreeVisibilitySnapshot } from '../slices/worktree-visibility-owner-settings'
import { getRepoHostIdentity } from '../slices/repo-host-identity'
import { getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
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
  type HostCatalogFence
} from '../host-catalog-fencing'
import {
  fetchRepoCatalogForTarget,
  filterSetupsForPrunedRepoRows,
  filterTrustedOrcaHooksToValidRepos,
  mergeFetchedRepoCatalog,
  projectCompatibilityForReconciledRepos,
  reconcileReadoptedSshWorktreeState,
  reconcileSupersededSshRepos
} from './repo-catalog-merge'
import { getRuntimeTargetHostId } from '../runtime-target-host'
import { listRuntimeEnvironmentsForAllHostLoad } from '../runtime-catalog-hosts'
import { mergeFetchedProjectCompatibilityForHost } from '../projects/project-compatibility-host-merge'
import { scheduleSafeAutoForkSync } from './safe-auto-fork-sync'

export function createAllHostRepoCatalogActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'fetchReposForAllHosts'> {
  return {
    fetchReposForAllHosts: async (options) => {
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
      // Why: fetching only the active host hides every other host's repos ("my projects vanished"); load local + all runtime envs, each failing soft.
      // Returns false for a dropped catalog: a superseded fetch or replaced connection is not an answer.
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
          const projectCompatibility = projectCompatibilityForReconciledRepos(
            finalizedRepos,
            catalog.projectHostSetupCompatibility
          )
          const mergedProjectCompatibility = mergeFetchedProjectCompatibilityForHost({
            previous: {
              projects: s.projects,
              projectHostSetups: filterSetupsForPrunedRepoRows(
                s.projectHostSetups,
                result.repos,
                finalizedRepos
              )
            },
            fetched: projectCompatibility,
            repos: finalizedRepos,
            hostId: result.hostId
          })
          hostRepos = finalizedRepos.filter(
            (repo) => getRepoExecutionHostId(repo) === result.hostId
          )
          return {
            repos: finalizedRepos,
            pendingSshRepoReadoptions: reconciliation.pendingReadoptions,
            ...reconcileReadoptedSshWorktreeState(s, s.pendingSshRepoReadoptions),
            ...mergedProjectCompatibility,
            ...(arrayElementsUnchanged(finalizedRepos, s.repos)
              ? {}
              : { folderWorkspacePathStatuses: {} }),
            activeRepoId: s.activeRepoId,
            filterRepoIds: s.filterRepoIds,
            setupScriptPromptDismissedRepoIds: s.setupScriptPromptDismissedRepoIds
          }
        })
        // Why: keep the safe-auto fork sync (as fetchRepos does) so cold-start, which now routes here, still updates safe-auto forks.
        scheduleSafeAutoForkSync(get, hostRepos)
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
        if (!applyCatalog(await fetchRepoCatalogForTarget({ kind: 'local' }), localFence)) {
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
        return
      }
      if (options?.remoteHosts === 'skip') {
        return
      }

      const environments = await listRuntimeEnvironmentsForAllHostLoad()
      // Why: a superseded load must not claim remote fences, or it would void the newer load's catalogs.
      if (latestAllHostRepoCatalogGenerationByStore.get(get) !== generation) {
        return
      }
      // Why: unreachable remotes can spend the full connect timeout; merge each resolved host via the state updater so parallel loads don't clobber.
      await Promise.all(
        environments.map(async (environment) => {
          const target = {
            kind: 'environment' as const,
            environmentId: environment.id
          }
          const fence = claimHostCatalogFence(get, 'repos', target)
          const [catalogResult, visibilitySnapshot] = await Promise.all([
            fetchRepoCatalogForTarget(target).then(
              (catalog) => ({ ok: true as const, catalog }),
              (error: unknown) => ({ ok: false as const, error })
            ),
            readRuntimeWorktreeVisibilitySnapshot(environment.id)
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
                    ...(getActiveRuntimeTarget(state.settings).kind === 'environment' &&
                    state.settings?.activeRuntimeEnvironmentId === environment.id
                      ? {
                          worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId:
                            visibilitySnapshot.sourceDefaultsSupported ? environment.id : null
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
              `Skipped repos for runtime environment ${environment.id}:`,
              catalogResult.error
            )
          }
        })
      )
      // Why: validate repo-scoped UI only after every host answers; first-paint loads only local repos, so an offline runtime would erase its saved filters.
      if (!failed && get().reposFetchGeneration === generation) {
        validateRepoScopedUi()
      }
    }
  }
}
