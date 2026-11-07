// Stopped WSL hosts still list their projects after a restart: seed rows from the desktop's saved answer.
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import type { HostRepoCatalogSnapshot } from '../../../../shared/host-repo-catalog-snapshot'
import { applyManualRepoOrder } from '../../../../shared/manual-repo-order'
import { adoptFromEndpoint } from '../adopt-from-endpoint'
import { getRepoRowIdentity } from './repo-host-identity'
import { isRemovedRuntimeHostId } from '../slices/stale-runtime-host-rows'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { hasLiveRepoCatalogApplied, markSavedHostCatalogRow } from './saved-host-catalog-rows'

/** Adds saved rows the store lacks; the host's next live list replaces them like any other row. */
export function withHostCatalogSnapshotRepos(
  repos: readonly Repo[],
  snapshots: Readonly<Record<string, HostRepoCatalogSnapshot>>,
  removedEnvironmentIds: ReadonlySet<string>,
  hasLiveList: (hostId: string) => boolean = () => false
): readonly Repo[] {
  const present = new Set(repos.map(getRepoRowIdentity))
  const added: Repo[] = []
  for (const [environmentId, snapshot] of Object.entries(snapshots)) {
    const hostId = toRuntimeExecutionHostId(environmentId)
    if (isRemovedRuntimeHostId(hostId, removedEnvironmentIds) || hasLiveList(hostId)) {
      continue
    }
    const target = { kind: 'environment' as const, environmentId }
    for (const row of snapshot.repos) {
      const repo = adoptFromEndpoint(target, { kind: 'repo', row })
      const identity = getRepoRowIdentity(repo)
      if (!present.has(identity)) {
        present.add(identity)
        markSavedHostCatalogRow(repo)
        added.push(repo)
      }
    }
  }
  return added.length > 0 ? [...repos, ...added] : repos
}

/** Run before any live host catalog request, so that answer can drop a project deleted on the host. */
export async function seedReposFromHostCatalogSnapshots(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Promise<void> {
  const list = window.api?.repos?.listHostCatalogSnapshots
  if (typeof list !== 'function') {
    return
  }
  let snapshots: Record<string, HostRepoCatalogSnapshot>
  try {
    snapshots = await list()
  } catch (error) {
    // Without the saved list a stopped host shows only its open workspaces, as before.
    console.warn('[repos] Could not read saved host project lists:', error)
    return
  }
  set((s) => {
    const repos = withHostCatalogSnapshotRepos(
      s.repos,
      snapshots,
      s.removedRuntimeEnvironmentIds,
      (hostId) => hasLiveRepoCatalogApplied(get, hostId)
    )
    return repos === s.repos ? s : { repos: applyManualRepoOrder(repos, s.manualRepoOrder) }
  })
}
