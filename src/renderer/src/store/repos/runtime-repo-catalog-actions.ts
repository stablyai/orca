import { settleAttentionRemovedBy } from '../slices/workspace-attention/attention-removal-follow-up'
import {
  flushRepoCatalogOwnerEdits,
  rememberAcceptedRepoCatalog,
  repoCatalogOwnerRemovalPatch
} from './repo-catalog-owner-reconciliation'
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import { applyManualRepoOrder } from '../../../../shared/manual-repo-order'
import { retainValidFilterRepoIds } from '../slices/repo-filter-selection'
import { readRuntimeWorktreeVisibilitySnapshot } from '../slices/worktree-visibility-owner-settings'
import { getRepoHostIdentity } from '../slices/repo-host-identity'
import { filterSetupScriptPromptDismissalsToValidRepos } from '@/lib/setup-script-prompt'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isRemovedRuntimeHostId } from '../slices/stale-runtime-host-rows'
import { claimHostCatalogFence, isHostCatalogFenceCurrent } from '../host-catalog-fencing'
import type { RepoSlice } from './repo-state'
import {
  fetchRepoCatalogForTarget,
  filterSetupsForPrunedRepoRows,
  mergeFetchedRepoCatalog,
  reconcileReadoptedSshWorktreeState,
  reconcileSupersededSshRepos
} from './repo-catalog-merge'
import { getRuntimeTargetHostId } from '../../runtime/runtime-client-target'
import { mergeFetchedHostProjectCatalog } from '../../../../shared/project-compatibility-host-merge'
import { scheduleSafeAutoForkSync } from './safe-auto-fork-sync'

export function createRuntimeRepoCatalogActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'fetchRuntimeEnvironmentRepos'> {
  return {
    fetchRuntimeEnvironmentRepos: async (environmentId) => {
      set((s) => ({ reposFetchGeneration: s.reposFetchGeneration + 1 }))
      const target = { kind: 'environment' as const, environmentId }
      const targetHostId = getRuntimeTargetHostId(target)
      const fence = claimHostCatalogFence(get, 'repos', target)
      try {
        const [catalog, visibilitySnapshot] = await Promise.all([
          fetchRepoCatalogForTarget(target),
          readRuntimeWorktreeVisibilitySnapshot(environmentId)
        ])
        const visibilityDefaults = visibilitySnapshot.defaults
        if (!isHostCatalogFenceCurrent(get, fence)) {
          return []
        }
        flushRepoCatalogOwnerEdits(get, catalog.repos, catalog.hostId)
        let exclusiveIds: string[] = []
        let finalizedHostRepos: Repo[] = []
        settleAttentionRemovedBy(set, get, () =>
          set((s) => {
            if (!isHostCatalogFenceCurrent(get, fence)) {
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
            const mergedProjectCompatibility = mergeFetchedHostProjectCatalog({
              previous: {
                projects: s.projects,
                projectHostSetups: filterSetupsForPrunedRepoRows(
                  s.projectHostSetups,
                  result.repos,
                  finalizedRepos
                )
              },
              fetched: catalog.projectHostSetupCompatibility,
              repos: finalizedRepos,
              hostId: result.hostId
            })
            finalizedHostRepos = finalizedRepos.filter(
              (repo) => getRepoExecutionHostId(repo) === result.hostId
            )
            const removal = repoCatalogOwnerRemovalPatch(
              { ...s, ...reconcileReadoptedSshWorktreeState(s, s.pendingSshRepoReadoptions) },
              finalizedRepos,
              result.hostId,
              get
            )
            exclusiveIds = removal.exclusiveIds
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
                ? s.settings.activeRuntimeEnvironmentId === environmentId
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
              ...removal.patch,
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
        )
        rememberAcceptedRepoCatalog(get, finalizedHostRepos, catalog.hostId, fence)
        if (exclusiveIds.length > 0) {
          get().removeWorkspaceSpaceWorktrees(exclusiveIds)
        }
        scheduleSafeAutoForkSync(finalizedHostRepos)
        return finalizedHostRepos
      } catch (err) {
        console.error(`Failed to fetch repos for runtime environment ${environmentId}:`, err)
        return []
      }
    }
  }
}
