import { settleAttentionRemovedBy } from '../slices/workspace-attention/attention-removal-follow-up'
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  normalizeWorkspaceSessionKeyToWorkspaceId,
  parseWorkspaceKey
} from '../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { isHostCatalogFenceCurrent, type HostCatalogFence } from '../host-catalog-fencing'
import { buildWorktreePurgeState } from '../slices/worktrees/teardown/worktree-purge-state'
import { flushPurgedWorkspaceEdits } from '../slices/worktrees/teardown/removed-workspace-unsaved-files'
import {
  deferInFlightRepoCatalogPurge,
  isRepoCatalogRemovalInFlight
} from './repo-catalog-removal-ownership'
import {
  planRepoCatalogOwnerRemoval,
  removedRepoCatalogHistoryPatch
} from './repo-catalog-owner-removal'

type StoreGet = () => AppState
type StoreSet = Parameters<StateCreator<AppState>>[0]
type AcceptedCatalog = { repos: readonly Repo[]; hostId: ExecutionHostId; fence: HostCatalogFence }
const acceptedCatalogsByStore = new WeakMap<StoreGet, Map<ExecutionHostId, AcceptedCatalog>>()

export function flushRepoCatalogOwnerEdits(
  get: StoreGet,
  repos: readonly Repo[],
  hostId: ExecutionHostId
): void {
  const state = get()
  const plan = planRepoCatalogOwnerRemoval(state, repos, hostId)
  flushPurgedWorkspaceEdits(
    state,
    plan.purgeTargets.filter(
      (target) => !isRepoCatalogRemovalInFlight(get, getRepoIdFromWorktreeId(target.id), hostId)
    )
  )
}

export function repoCatalogOwnerRemovalPatch(
  state: AppState,
  repos: readonly Repo[],
  hostId: ExecutionHostId,
  get: StoreGet
): { patch: Partial<AppState>; exclusiveIds: string[] } {
  const plan = planRepoCatalogOwnerRemoval(state, repos, hostId)
  const targets = plan.purgeTargets.filter((target) => !deferInFlightRepoCatalogPurge(get, target))
  const purgePatch = targets.length > 0 ? buildWorktreePurgeState(state, targets) : {}
  return {
    patch: {
      ...purgePatch,
      ...plan.rows,
      ...removedRepoCatalogHistoryPatch({ ...state, ...purgePatch }, plan.historyTargets)
    },
    exclusiveIds: plan.exclusiveIds
  }
}

export function rememberAcceptedRepoCatalog(
  get: StoreGet,
  repos: readonly Repo[],
  hostId: ExecutionHostId,
  fence: HostCatalogFence
): void {
  if (!isHostCatalogFenceCurrent(get, fence)) {
    return
  }
  const catalogs = acceptedCatalogsByStore.get(get) ?? new Map()
  acceptedCatalogsByStore.set(get, catalogs)
  catalogs.set(hostId, { repos, hostId, fence })
}

// A session may hydrate after its first catalog; replay only still-current accepted proof.
export function reconcileAcceptedRepoCatalogOwners(set: StoreSet, get: StoreGet): void {
  for (const catalog of acceptedCatalogsByStore.get(get)?.values() ?? []) {
    if (!isHostCatalogFenceCurrent(get, catalog.fence)) {
      continue
    }
    flushRepoCatalogOwnerEdits(get, [...catalog.repos, ...get().repos], catalog.hostId)
    let exclusiveIds: string[] = []
    settleAttentionRemovedBy(set, get, () =>
      set((state) => {
        if (!isHostCatalogFenceCurrent(get, catalog.fence)) {
          return state
        }
        const removal = repoCatalogOwnerRemovalPatch(
          state,
          [...catalog.repos, ...state.repos],
          catalog.hostId,
          get
        )
        exclusiveIds = removal.exclusiveIds
        return removal.patch
      })
    )
    if (exclusiveIds.length > 0) {
      get().removeWorkspaceSpaceWorktrees(exclusiveIds)
    }
  }
}

export function acceptedRepoCatalogConfirmsRemoval(
  get: StoreGet,
  repoId: string,
  hostId: ExecutionHostId
): boolean {
  const catalog = acceptedCatalogsByStore.get(get)?.get(hostId)
  return Boolean(
    catalog &&
    isHostCatalogFenceCurrent(get, catalog.fence) &&
    !catalog.repos.some((repo) => repo.id === repoId) &&
    !get().repos.some((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId)
  )
}

export function filterAcceptedRepoCatalogSessionOwners(
  get: StoreGet,
  owners: Readonly<Record<string, ExecutionHostId>>
): Record<string, ExecutionHostId> {
  return Object.fromEntries(
    Object.entries(owners).filter(([key, hostId]) => {
      const id = normalizeWorkspaceSessionKeyToWorkspaceId(key)
      return (
        parseWorkspaceKey(id)?.type === 'folder' ||
        !acceptedRepoCatalogConfirmsRemoval(get, getRepoIdFromWorktreeId(id), hostId)
      )
    })
  )
}
