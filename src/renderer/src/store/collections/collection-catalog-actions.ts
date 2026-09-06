import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Collection } from '../../../../shared/collection-types'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  type RuntimeClientTarget
} from '../../runtime/runtime-rpc-client'
import { claimHostCatalogFence, isHostCatalogFenceCurrent } from '../host-catalog-fencing'
import { getRuntimeTargetHostId } from '../runtime-target-host'
import type { RepoSlice } from '../repos/repo-state'

export async function fetchCollectionsForTarget(
  target: RuntimeClientTarget
): Promise<Collection[]> {
  return target.kind === 'local'
    ? await window.api.collections.list()
    : (
        await callRuntimeRpc<{ collections: Collection[] }>(target, 'collection.list', undefined, {
          timeoutMs: 15_000,
          reuseRecentCompatibilityFailure: true
        })
      ).collections
}

export function createCollectionCatalogActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'fetchCollections'> {
  return {
    fetchCollections: async () => {
      try {
        const target = getActiveRuntimeTarget(get().settings)
        const fence = claimHostCatalogFence(get, 'collections', target)
        const collections = await fetchCollectionsForTarget(target)
        // Why: collections state is replace-not-merge, so beyond the fence the
        // focused host must still be the fetched one or a stale list wins.
        const isFetchCurrent = (): boolean =>
          isHostCatalogFenceCurrent(get, fence) &&
          getRuntimeTargetHostId(getActiveRuntimeTarget(get().settings)) ===
            getRuntimeTargetHostId(fence.target)
        if (!isFetchCurrent()) {
          return
        }
        set((current) => (isFetchCurrent() ? { collections } : current))
      } catch (err) {
        // Why: older paired runtimes predate collection.* methods; keep the sidebar usable.
        console.warn('Failed to fetch collections:', err)
      }
    }
  }
}
