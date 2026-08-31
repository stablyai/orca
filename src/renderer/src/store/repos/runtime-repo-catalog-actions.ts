import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import { applyManualRepoOrder } from '../../../../shared/manual-repo-order'
import { retainValidFilterRepoIds } from '../slices/repo-filter-selection'
import { readRuntimeWorktreeVisibilitySnapshot } from '../slices/worktree-visibility-owner-settings'
import { getRepoHostIdentity } from '../slices/repo-host-identity'
import { getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { filterSetupScriptPromptDismissalsToValidRepos } from '@/lib/setup-script-prompt'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isRemovedRuntimeHostId } from '../slices/stale-runtime-host-rows'
import { getEnvironmentSshStateGeneration } from '../slices/runtime-environment-ssh'
import { getRuntimeEnvironmentConnectionGeneration } from '../slices/runtime-status'
import type { RepoSlice } from './repo-state'
import { claimRepoCatalogGeneration, isLatestRepoCatalogGeneration } from './repo-catalog-fencing'
import {
  fetchRepoCatalogForTarget,
  filterSetupsForPrunedRepoRows,
  mergeFetchedRepoCatalog,
  projectCompatibilityForReconciledRepos,
  reconcileReadoptedSshWorktreeState,
  reconcileSupersededSshRepos
} from './repo-catalog-merge'
import { getRuntimeTargetHostId } from '../runtime-target-host'
import { mergeFetchedProjectCompatibilityForHost } from '../projects/project-compatibility-host-merge'
import { scheduleSafeAutoForkSync } from './safe-auto-fork-sync'

export const runtimeRepoFetchGenerationByEnvironment = new Map<string, number>()

export function createRuntimeRepoCatalogActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'fetchRuntimeEnvironmentRepos'> {
  return {
    fetchRuntimeEnvironmentRepos: async (environmentId) => {
      const requestGeneration =
        (runtimeRepoFetchGenerationByEnvironment.get(environmentId) ?? 0) + 1
      runtimeRepoFetchGenerationByEnvironment.set(environmentId, requestGeneration)
      const connectionGeneration = getEnvironmentSshStateGeneration(environmentId)
      const runtimeConnectionGeneration = getRuntimeEnvironmentConnectionGeneration(environmentId)
      let catalogGeneration = 0
      set((s) => {
        catalogGeneration = s.reposFetchGeneration + 1
        return { reposFetchGeneration: catalogGeneration }
      })
      const target = { kind: 'environment' as const, environmentId }
      const targetHostId = getRuntimeTargetHostId(target)
      claimRepoCatalogGeneration(get, targetHostId, catalogGeneration)
      try {
        const [catalog, visibilitySnapshot] = await Promise.all([
          fetchRepoCatalogForTarget(target),
          readRuntimeWorktreeVisibilitySnapshot(environmentId)
        ])
        const visibilityDefaults = visibilitySnapshot.defaults
        if (
          runtimeRepoFetchGenerationByEnvironment.get(environmentId) !== requestGeneration ||
          !isLatestRepoCatalogGeneration(get, targetHostId, catalogGeneration) ||
          getEnvironmentSshStateGeneration(environmentId) !== connectionGeneration ||
          getRuntimeEnvironmentConnectionGeneration(environmentId) !== runtimeConnectionGeneration
        ) {
          return []
        }
        let finalizedHostRepos: Repo[] = []
        set((s) => {
          if (
            runtimeRepoFetchGenerationByEnvironment.get(environmentId) !== requestGeneration ||
            !isLatestRepoCatalogGeneration(get, targetHostId, catalogGeneration) ||
            getEnvironmentSshStateGeneration(environmentId) !== connectionGeneration ||
            getRuntimeEnvironmentConnectionGeneration(environmentId) !== runtimeConnectionGeneration
          ) {
            return s
          }
          // Why: skip merging a runtime env removed while this Connect-flow fetch was in flight, so purged repos aren't re-added (#8881).
          if (isRemovedRuntimeHostId(catalog.hostId, s.removedRuntimeEnvironmentIds)) {
            return s
          }
          const result = mergeFetchedRepoCatalog(catalog, s.repos)
          const reconciliation = reconcileSupersededSshRepos(result.repos, s)
          const finalizedRepos = applyManualRepoOrder(reconciliation.repos, s.manualRepoOrder)
          const validRepoIds = new Set(finalizedRepos.map((repo) => repo.id))
          const validRepoHostIdentities = new Set(finalizedRepos.map(getRepoHostIdentity))
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
          finalizedHostRepos = finalizedRepos.filter(
            (repo) => getRepoExecutionHostId(repo) === result.hostId
          )
          return {
            repos: finalizedRepos,
            ...(visibilityDefaults === undefined
              ? {}
              : {
                  worktreeVisibilityDefaultsByHost: {
                    ...s.worktreeVisibilityDefaultsByHost,
                    [targetHostId]: visibilityDefaults
                  }
                }),
            ...(visibilityDefaults !== undefined && s.settings
              ? getActiveRuntimeTarget(s.settings).kind === 'environment' &&
                s.settings.activeRuntimeEnvironmentId === environmentId
                ? visibilityDefaults
                  ? {
                      settings: {
                        ...s.settings,
                        worktreeVisibilityDefaults: visibilityDefaults
                      },
                      worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId: environmentId,
                      worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId:
                        visibilitySnapshot.sourceDefaultsSupported ? environmentId : null
                    }
                  : {
                      settings: Object.fromEntries(
                        Object.entries(s.settings).filter(
                          ([key]) => key !== 'worktreeVisibilityDefaults'
                        )
                      ) as GlobalSettings,
                      worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId: null,
                      worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId: null
                    }
                : {}
              : {}),
            pendingSshRepoReadoptions: reconciliation.pendingReadoptions,
            ...reconcileReadoptedSshWorktreeState(s, s.pendingSshRepoReadoptions),
            ...mergedProjectCompatibility,
            activeRepoId:
              s.activeRepoId && validRepoIds.has(s.activeRepoId) ? s.activeRepoId : null,
            filterRepoIds: retainValidFilterRepoIds(s.filterRepoIds, validRepoIds),
            setupScriptPromptDismissedRepoIds: filterSetupScriptPromptDismissalsToValidRepos(
              s.setupScriptPromptDismissedRepoIds,
              validRepoHostIdentities
            )
          }
        })
        scheduleSafeAutoForkSync(get, finalizedHostRepos)
        return finalizedHostRepos
      } catch (err) {
        console.error(`Failed to fetch repos for runtime environment ${environmentId}:`, err)
        return []
      }
    }
  }
}
