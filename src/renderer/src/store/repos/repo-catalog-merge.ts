import type { AppState } from '../types'
import type { SshRepoReadoption } from '../../../../shared/ssh-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import { reconcileReadoptedSshRepoRows } from '../slices/superseded-ssh-repo-rows'
import type { SshRepoReconciliation } from '../slices/superseded-ssh-repo-rows'
import { reconcileReadoptedSshWorktreesByRepo } from '../slices/readopted-ssh-worktree-rows'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import type { getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { RepoSlice } from './repo-state'
import { repoWithFetchedOwner } from './owner-routing'
import { getRuntimeTargetHostId } from '../runtime-target-host'
import { fetchProjectHostSetupCompatibility } from '../projects/project-host-routing'
import { mergeFetchedReposForHost } from './repo-catalog-identity'
import { worktreeMatchesHost } from '../slices/worktrees/listing/worktree-host-ownership'
import {
  mergeProjectHostSetupCompatibility,
  projectCompatibilityFromRepos
} from '../projects/project-compatibility-core'

export type FetchedRepoCatalog = {
  repos: readonly Repo[]
  projectHostSetupCompatibility: ProjectHostSetupProjection
  hostId: ReturnType<typeof getRuntimeTargetHostId>
}

export async function fetchRepoCatalogForTarget(
  target: ReturnType<typeof getActiveRuntimeTarget>
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
  const repos = fetchedRepos.map((repo) => repoWithFetchedOwner(repo, target))
  return {
    repos,
    projectHostSetupCompatibility: await fetchProjectHostSetupCompatibility(target, repos),
    hostId: getRuntimeTargetHostId(target)
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

function splitRowsByHost<
  T extends { id: string; hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }
>(rows: readonly T[], hostId: ExecutionHostId): { kept: T[]; droppedIds: string[] } {
  const kept: T[] = []
  const droppedIds: string[] = []
  for (const row of rows) {
    if (worktreeMatchesHost(row, hostId)) {
      droppedIds.push(row.id)
    } else {
      kept.push(row)
    }
  }
  return { kept, droppedIds }
}

// Why: a repo removed outside this window leaves only via refetch, and its rows would linger as "Unknown". Ids the store never had may still be hydrating; other hosts' rows (restored placeholders) stay.
export function dropWorktreeRowsForRemovedRepos(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'sortEpoch'>,
  previousRepos: readonly Repo[],
  validRepoIds: ReadonlySet<string>,
  hostId: ExecutionHostId
): {
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'sortEpoch'>
  droppedWorktreeIds: string[]
} {
  const worktreesByRepo = { ...state.worktreesByRepo }
  const detectedWorktreesByRepo = { ...state.detectedWorktreesByRepo }
  const droppedWorktreeIds = new Set<string>()
  // Why: tabs and the active selection are keyed by raw id, which a surviving host's twin row may share.
  const keptWorktreeIds = new Set<string>()
  let rowsDropped = false
  for (const id of new Set(previousRepos.map((repo) => repo.id))) {
    if (validRepoIds.has(id)) {
      continue
    }
    const listed = splitRowsByHost(worktreesByRepo[id] ?? [], hostId)
    listed.kept.forEach((row) => keptWorktreeIds.add(row.id))
    if (listed.droppedIds.length > 0) {
      rowsDropped = true
      listed.droppedIds.forEach((worktreeId) => droppedWorktreeIds.add(worktreeId))
      if (listed.kept.length > 0) {
        worktreesByRepo[id] = listed.kept
      } else {
        delete worktreesByRepo[id]
      }
    }
    const detected = detectedWorktreesByRepo[id]
    const detectedRows = splitRowsByHost(detected?.worktrees ?? [], hostId)
    detectedRows.kept.forEach((row) => keptWorktreeIds.add(row.id))
    if (detected && detectedRows.droppedIds.length > 0) {
      rowsDropped = true
      detectedRows.droppedIds.forEach((worktreeId) => droppedWorktreeIds.add(worktreeId))
      if (detectedRows.kept.length > 0) {
        detectedWorktreesByRepo[id] = { ...detected, worktrees: detectedRows.kept }
      } else {
        delete detectedWorktreesByRepo[id]
      }
    }
  }
  if (!rowsDropped) {
    return { state, droppedWorktreeIds: [] }
  }
  return {
    state: { worktreesByRepo, detectedWorktreesByRepo, sortEpoch: state.sortEpoch + 1 },
    droppedWorktreeIds: [...droppedWorktreeIds].filter((id) => !keptWorktreeIds.has(id))
  }
}

export function projectCompatibilityForReconciledRepos(
  repos: readonly Repo[],
  fetched: ProjectHostSetupProjection
): Pick<RepoSlice, 'projects' | 'projectHostSetups'> {
  return mergeProjectHostSetupCompatibility(projectCompatibilityFromRepos(repos), fetched)
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
