import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { Collection } from '../../../../shared/collection-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { getRuntimeTargetHostId } from '../../runtime/runtime-client-target'
import { defaultScopeHost } from '../../lib/default-creation-host'
import { claimHostCatalogFence, isHostCatalogFenceCurrent } from '../host-catalog-fencing'
import type { RepoSlice } from '../repos/repo-state'

export function createCollectionCatalogActions(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<RepoSlice, 'fetchCollections'> {
  return {
    fetchCollections: async () => {
      try {
        const target = defaultScopeHost(get().settings)
        const fence = claimHostCatalogFence(get, 'collections', target)
        const collections =
          target.kind === 'local'
            ? await window.api.collections.list()
            : (
                await callRuntimeRpc<{ collections: Collection[] }>(
                  target,
                  'collection.list',
                  undefined,
                  { timeoutMs: 15_000, reuseRecentCompatibilityFailure: true }
                )
              ).collections
        // Why: state is replace-not-merge, so the focused host must still be the fetched one.
        const isFetchCurrent = (): boolean =>
          isHostCatalogFenceCurrent(get, fence) &&
          getRuntimeTargetHostId(defaultScopeHost(get().settings)) ===
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
