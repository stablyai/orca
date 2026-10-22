import type { StateCreator } from 'zustand'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { awaitMainProjectCatalogShows, hasMainProjectCatalog } from '@/lib/main-project-catalog'
import type { AppState } from '../types'
import { selectRepos } from '../project-catalog-selectors'
import { reconcileReadoptedSshRepoRows } from '../slices/superseded-ssh-repo-rows'
import { arrayElementsUnchanged } from '../catalog-identity'
import { reconcileReadoptedSshWorktreeState } from './repo-catalog-merge'
import { scheduleSafeAutoForkSync } from './safe-auto-fork-sync'

type StoreGet = Parameters<StateCreator<AppState>>[1]

// The repo ids main's catalog held at the last reconcile, per store.
const reconciledRepoIdsByStore = new WeakMap<StoreGet, ReadonlySet<string>>()

/**
 * Switch-on, in place of a repo fetch: once main's catalog is read past this call, drops the
 * window's own references (selection, filters, hook trust) to repos main's catalog no longer
 * holds, and moves SSH re-adoptions. Returns that host's repos; none while main's catalog has
 * never arrived.
 */
export async function reconcileWindowWithMainCatalog(
  set: Parameters<StateCreator<AppState>>[0],
  get: StoreGet,
  hostId: ExecutionHostId | null
): Promise<Repo[]> {
  await awaitMainProjectCatalogShows(() => true)
  // Why: an empty catalog that never arrived must not clear the selection as if every repo left.
  if (!hasMainProjectCatalog()) {
    return []
  }
  const repos = selectRepos(get())
  const repoIds = new Set(repos.map((repo) => repo.id))
  // Why only ids main dropped: a paired server main has not reached yet must keep its saved filters.
  const before = reconciledRepoIdsByStore.get(get) ?? new Set<string>()
  reconciledRepoIdsByStore.set(get, repoIds)
  const removed = new Set([...before].filter((id) => !repoIds.has(id)))
  set((s) => {
    const pending = reconcileReadoptedSshRepoRows(repos, s.pendingSshRepoReadoptions)
    const filterRepoIds = s.filterRepoIds.filter((id) => !removed.has(id))
    const trustedOrcaHooks = Object.keys(s.trustedOrcaHooks).some((id) => removed.has(id))
      ? Object.fromEntries(Object.entries(s.trustedOrcaHooks).filter(([id]) => !removed.has(id)))
      : s.trustedOrcaHooks
    return {
      activeRepoId: s.activeRepoId && removed.has(s.activeRepoId) ? null : s.activeRepoId,
      filterRepoIds: arrayElementsUnchanged(filterRepoIds, s.filterRepoIds)
        ? s.filterRepoIds
        : filterRepoIds,
      trustedOrcaHooks,
      pendingSshRepoReadoptions: arrayElementsUnchanged(
        pending.pendingReadoptions,
        s.pendingSshRepoReadoptions
      )
        ? s.pendingSshRepoReadoptions
        : pending.pendingReadoptions,
      ...(s.pendingSshRepoReadoptions.length === 0
        ? {}
        : reconcileReadoptedSshWorktreeState(s, s.pendingSshRepoReadoptions))
    }
  })
  const hostRepos = hostId
    ? repos.filter((repo) => getRepoExecutionHostId(repo) === hostId)
    : [...repos]
  scheduleSafeAutoForkSync(hostRepos)
  return hostRepos
}
