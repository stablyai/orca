import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { lineageStoreKeyOfTarget, withStoreCrossStoreLineage } from './cross-store-lineage-state'
import { listWorktreeLineageForRuntime } from './worktree-lineage-refresh'
import type { BackgroundRuntimeRefreshOptions } from '../listing/worktree-slice-types'

/** Startup hydration of a store's cross-machine links and this desktop's identity only; the
 * focused store's refresh still owns the same-store maps, which are keyed by bare id. */
export async function refreshCrossStoreLineageForTarget(
  target: RuntimeClientTarget,
  set: Parameters<StateCreator<AppState>>[0],
  getState: () => Pick<AppState, 'crossStoreLineageByStoreKey'>,
  options: BackgroundRuntimeRefreshOptions = {}
): Promise<void> {
  const requestStart = { crossStoreLineageByStoreKey: getState().crossStoreLineageByStoreKey }
  const lineage = await listWorktreeLineageForRuntime(target, options)
  const storeKey = lineageStoreKeyOfTarget(target)
  set((s) => {
    const crossStore = withStoreCrossStoreLineage(s, storeKey, lineage, requestStart)
    return Object.keys(crossStore).length === 0 ? s : crossStore
  })
}
