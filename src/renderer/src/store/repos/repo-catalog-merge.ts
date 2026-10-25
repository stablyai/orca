import type { AppState } from '../types'
import type { SshRepoReadoption } from '../../../../shared/ssh-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import { reconcileReadoptedSshRepoRows } from '../slices/superseded-ssh-repo-rows'
import type { SshRepoReconciliation } from '../slices/superseded-ssh-repo-rows'
import { reconcileReadoptedSshWorktreesByRepo } from '../slices/readopted-ssh-worktree-rows'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { adoptFromEndpoint } from '../adopt-from-endpoint'
import { getRuntimeTargetHostId } from '../../runtime/runtime-client-target'
import { fetchProjectHostSetupCompatibility } from '../projects/project-host-routing'
import { mergeFetchedReposForHost } from './repo-catalog-identity'
import { dropWorktreeRowsOfDroppedRepos } from './dropped-repo-worktree-rows'
import { getRepoHostIdentity } from '../slices/repo-host-identity'

export type FetchedRepoCatalog = {
  repos: readonly Repo[]
  projectHostSetupCompatibility: ProjectHostSetupProjection
  hostId: ReturnType<typeof getRuntimeTargetHostId>
  /** This store's repo rows when the request went out; a registration added since is not its to drop. */
  reposAtRequest: readonly Repo[]
}

export async function fetchRepoCatalogForTarget(
  target: RuntimeClientTarget,
  reposAtRequest: readonly Repo[]
): Promise<FetchedRepoCatalog> {
  const fetchedRepos =
    target.kind === 'local'
      ? await window.api.repos.list()
      : (
          await callRuntimeRpc<{ repos: Repo[] }>(target, 'repo.list', undefined, {
            timeoutMs: 15_000,
            reuseRecentCompatibilityFailure: true
          })
        ).repos
  const repos = fetchedRepos.map((repo) => adoptFromEndpoint(target, { kind: 'repo', row: repo }))
  return {
    repos,
    projectHostSetupCompatibility: await fetchProjectHostSetupCompatibility(target, repos),
    hostId: getRuntimeTargetHostId(target),
    reposAtRequest
  }
}

export function mergeFetchedRepoCatalog(
  catalog: FetchedRepoCatalog,
  currentRepos: readonly Repo[]
): {
  repos: readonly Repo[]
  projectHostSetupCompatibility: ProjectHostSetupProjection
  hostId: ReturnType<typeof getRuntimeTargetHostId>
} {
  const repos = mergeFetchedReposForHost(currentRepos, catalog.repos, catalog.hostId)
  return {
    repos,
    projectHostSetupCompatibility: catalog.projectHostSetupCompatibility,
    hostId: catalog.hostId
  }
}

export function reconcileSupersededSshRepos(
  repos: readonly Repo[],
  state: Pick<AppState, 'pendingSshRepoReadoptions'>
): SshRepoReconciliation {
  return reconcileReadoptedSshRepoRows(repos, state.pendingSshRepoReadoptions)
}

export function filterSetupsForPrunedRepoRows(
  setups: readonly ProjectHostSetup[],
  mergedRepos: readonly Repo[],
  reconciledRepos: readonly Repo[]
): readonly ProjectHostSetup[] {
  const survivingOwners = new Set(
    reconciledRepos.map((repo) => `${getRepoExecutionHostId(repo)}:${repo.id}`)
  )
  const prunedOwners = new Set(
    mergedRepos
      .filter((repo) => !survivingOwners.has(`${getRepoExecutionHostId(repo)}:${repo.id}`))
      .map((repo) => `${getRepoExecutionHostId(repo)}:${repo.id}`)
  )
  // Why: this result feeds the compat merge as `previous`, so an unconditional copy would discard
  // the identity that merge is about to try to preserve.
  if (prunedOwners.size === 0) {
    return setups
  }
  const filtered = setups.filter(
    (setup) => !setup.repoId || !prunedOwners.has(`${setup.hostId}:${setup.repoId}`)
  )
  return filtered.length === setups.length ? setups : filtered
}

export function reconcileReadoptedSshWorktreeState(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'sortEpoch'>,
  readoptions: readonly SshRepoReadoption[]
): Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'sortEpoch'> {
  const worktreesByRepo = reconcileReadoptedSshWorktreesByRepo(state.worktreesByRepo, readoptions)
  const detectedRows = Object.fromEntries(
    Object.entries(state.detectedWorktreesByRepo).map(([repoId, result]) => [
      repoId,
      result.worktrees
    ])
  )
  const reconciledDetectedRows = reconcileReadoptedSshWorktreesByRepo(detectedRows, readoptions)
  const detectedWorktreesByRepo =
    reconciledDetectedRows === detectedRows
      ? state.detectedWorktreesByRepo
      : Object.fromEntries(
          Object.entries(state.detectedWorktreesByRepo).map(([repoId, result]) => [
            repoId,
            { ...result, worktrees: reconciledDetectedRows[repoId] }
          ])
        )
  return {
    worktreesByRepo,
    detectedWorktreesByRepo,
    sortEpoch: worktreesByRepo === state.worktreesByRepo ? state.sortEpoch : state.sortEpoch + 1
  }
}

/** The worktree rows a fetched catalog leaves: re-adopted SSH rows moved, dropped repos' rows gone. */
export function reconcileFetchedCatalogWorktreeState(
  state: Pick<
    AppState,
    | 'repos'
    | 'pendingSshRepoReadoptions'
    | 'worktreesByRepo'
    | 'detectedWorktreesByRepo'
    | 'sortEpoch'
  >,
  catalog: Pick<FetchedRepoCatalog, 'reposAtRequest'>,
  nextRepos: readonly Repo[]
): Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'sortEpoch'> {
  const readopted = reconcileReadoptedSshWorktreeState(state, state.pendingSshRepoReadoptions)
  // Why: a catalog requested before an add may omit it; that add's rows are not this answer's to drop.
  const requested = new Set(catalog.reposAtRequest.map(getRepoHostIdentity))
  const previous = state.repos.filter((repo) => requested.has(getRepoHostIdentity(repo)))
  return dropWorktreeRowsOfDroppedRepos(readopted, previous, nextRepos)
}

export function filterTrustedOrcaHooksToValidRepos(
  trust: AppState['trustedOrcaHooks'],
  validRepoIds: Set<string>
): AppState['trustedOrcaHooks'] {
  const next: AppState['trustedOrcaHooks'] = {}
  for (const [repoId, entry] of Object.entries(trust)) {
    if (validRepoIds.has(repoId)) {
      next[repoId] = entry
    }
  }
  return next
}
