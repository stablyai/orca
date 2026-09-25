import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { applyManualRepoOrder } from '../../../../shared/manual-repo-order'
import { reconcileCatalogRows } from '../slices/repo-identity-reconcile'
import { retainValidFilterRepoIds } from '../slices/repo-filter-selection'
import {
  mergeSshRepoReadoptions,
  reconcileReadoptedSshRepoRows
} from '../slices/superseded-ssh-repo-rows'
import { getRepoHostIdentity } from '../slices/repo-host-identity'
import { getActiveRuntimeTarget, settingsForRuntimeOwner } from '../../runtime/runtime-rpc-client'
import { filterSetupScriptPromptDismissalsToValidRepos } from '@/lib/setup-script-prompt'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { isRemovedRuntimeHostId } from '../slices/stale-runtime-host-rows'
import type { LocalRepoCatalogFetchOutcome } from './repo-catalog-fencing'
import type { RepoSlice } from './repo-state'
import { arrayElementsUnchanged } from '../catalog-identity'
import {
  awaitLatestLocalRepoCatalogFetch,
  claimRepoCatalogGeneration,
  isLatestRepoCatalogGeneration,
  startLocalRepoCatalogFetch
} from './repo-catalog-fencing'
import {
  fetchRepoCatalogForTarget,
  filterSetupsForPrunedRepoRows,
  mergeFetchedRepoCatalog,
  projectCompatibilityForReconciledRepos,
  reconcileReadoptedSshWorktreeState,
  reconcileSupersededSshRepos
} from './repo-catalog-merge'
import {
  getProjectHostSetupOwnerKey,
  mergeProjectHostSetupCompatibility,
  projectCompatibilityFromRepos
} from '../projects/project-compatibility-core'
import { getRuntimeTargetHostId } from '../runtime-target-host'
import { mergeFetchedProjectCompatibilityForHost } from '../projects/project-compatibility-host-merge'
import { scheduleSafeAutoForkSync } from './safe-auto-fork-sync'

export function createRepoCatalogActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'recordSshRepoReadoptions' | 'fetchRepos' | 'awaitLocalRepoCatalogSettlement'> {
  return {
    recordSshRepoReadoptions: (readoptions) =>
      set((s) => {
        // Why: SshPane importConfig() often reports [] on every Manage-pane open.
        if (readoptions.length === 0 && s.pendingSshRepoReadoptions.length === 0) {
          return s
        }
        const pendingSshRepoReadoptions = mergeSshRepoReadoptions(
          s.pendingSshRepoReadoptions,
          readoptions
        )
        const reconciliation = reconcileReadoptedSshRepoRows(s.repos, pendingSshRepoReadoptions)
        const repos = reconciliation.repos
        const worktreeState = reconcileReadoptedSshWorktreeState(s, pendingSshRepoReadoptions)
        const remainingSetups = filterSetupsForPrunedRepoRows(s.projectHostSetups, s.repos, repos)
        const compatibility = mergeProjectHostSetupCompatibility(
          projectCompatibilityFromRepos(repos),
          {
            projects: s.projects,
            setups: remainingSetups
          }
        )
        // Why: mergeProjectHostSetupCompatibility always allocates; a no-op readoption
        // must not churn catalog identity. This write is all-repos, not host-scoped,
        // so it cannot go through mergeFetchedProjectCompatibilityForHost. Reconcile
        // hands the store arrays straight back when nothing moved, so writing them
        // unconditionally still leaves identity-keyed selectors untouched.
        const projects = reconcileCatalogRows(
          s.projects,
          compatibility.projects,
          (project) => project.id
        )
        const projectHostSetups = reconcileCatalogRows(
          s.projectHostSetups,
          compatibility.projectHostSetups,
          getProjectHostSetupOwnerKey
        )
        return {
          repos,
          pendingSshRepoReadoptions: reconciliation.pendingReadoptions,
          ...worktreeState,
          projects,
          projectHostSetups
        }
      }),

    fetchRepos: async (options) => {
      const target = getActiveRuntimeTarget(
        settingsForRuntimeOwner(get().settings, options?.runtimeEnvironmentId)
      )
      const settleLocalCatalog: (outcome: LocalRepoCatalogFetchOutcome) => void =
        target.kind === 'local' ? startLocalRepoCatalogFetch(get) : () => undefined
      let localCatalogOutcome: LocalRepoCatalogFetchOutcome = { status: 'fulfilled' }
      // Why: overlapping repos:changed fetches can resolve out of order; a stale one must not overwrite a newer result and resurrect deleted projects (#7020).
      let generation = 0
      set((s) => {
        generation = s.reposFetchGeneration + 1
        return { reposFetchGeneration: generation }
      })
      const targetHostId = getRuntimeTargetHostId(target)
      claimRepoCatalogGeneration(get, targetHostId, generation)
      try {
        const catalog = await fetchRepoCatalogForTarget(target)
        // A newer same-host fetch superseded us while we awaited — drop this stale result.
        if (!isLatestRepoCatalogGeneration(get, targetHostId, generation)) {
          return
        }
        let finalizedHostRepos: Repo[] = []
        set((s) => {
          // Why: an in-flight fetch for a just-removed env would re-add purged repos and stick; skip only when the env was tombstoned, not merely unhydrated (#8881).
          if (isRemovedRuntimeHostId(catalog.hostId, s.removedRuntimeEnvironmentIds)) {
            return s
          }
          // Why: re-adoption leaves a stale row on the old SSH target id (a ghost that fails "SSH target not found"); drop rows a live-host sibling supersedes.
          const result = mergeFetchedRepoCatalog(catalog, s.repos)
          const reconciliation = reconcileSupersededSshRepos(result.repos, s)
          const prunedRepos = applyManualRepoOrder(reconciliation.repos, s.manualRepoOrder)
          const validRepoIds = new Set(prunedRepos.map((repo) => repo.id))
          const validRepoHostIdentities = new Set(prunedRepos.map(getRepoHostIdentity))
          const projectCompatibility = projectCompatibilityForReconciledRepos(
            prunedRepos,
            catalog.projectHostSetupCompatibility
          )
          const mergedProjectCompatibility = mergeFetchedProjectCompatibilityForHost({
            previous: {
              projects: s.projects,
              projectHostSetups: filterSetupsForPrunedRepoRows(
                s.projectHostSetups,
                result.repos,
                prunedRepos
              )
            },
            fetched: projectCompatibility,
            repos: prunedRepos,
            hostId: result.hostId
          })
          finalizedHostRepos = prunedRepos.filter(
            (repo) => getRepoExecutionHostId(repo) === result.hostId
          )
          return {
            repos: prunedRepos,
            pendingSshRepoReadoptions: reconciliation.pendingReadoptions,
            ...reconcileReadoptedSshWorktreeState(s, s.pendingSshRepoReadoptions),
            ...mergedProjectCompatibility,
            ...(arrayElementsUnchanged(prunedRepos, s.repos)
              ? {}
              : { folderWorkspacePathStatuses: {} }),
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
      } catch (err) {
        localCatalogOutcome = { status: 'rejected', reason: err }
        console.error('Failed to fetch repos:', err)
      } finally {
        settleLocalCatalog(localCatalogOutcome)
      }
    },

    awaitLocalRepoCatalogSettlement: () => awaitLatestLocalRepoCatalogFetch(get)
  }
}
