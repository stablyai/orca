import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { addAdditionalValidWorkspaceKeys } from '@/lib/workspace-session-hydration-keys'
import {
  buildValidWorktreeIdsForSessionHydration,
  collectPersistedWorktreeIdsForSessionHydration
} from '../degraded-repo-worktree-validity'
import { buildHydratedTabState } from '../tabs-hydration'
import { projectWorktreeTabModelReconciliation } from './tabs-reconciliation'
import { createWorktreeTabModelReconciliationBatch } from './tabs-reconciliation-batch'
import type { AppState } from '../../types'

function replaceWorkspaceRecordKeys<T>(
  current: Record<string, T>,
  hydrated: Record<string, T>,
  workspaceKeys: ReadonlySet<string>
): Record<string, T> {
  return {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => !workspaceKeys.has(key))),
    ...Object.fromEntries(Object.entries(hydrated).filter(([key]) => workspaceKeys.has(key)))
  }
}

/**
 * Folds every workspace's reconciliation into one patch. Equivalent to
 * applying each patch with its own `set()`: each projection reads the state
 * left by its predecessors (they share `unreadTerminalTabs` and the orphan
 * cleanup maps), only the store write and subscriber fanout are deferred.
 */
function projectWorktreeTabModelReconciliations(
  state: AppState,
  worktreeIds: readonly string[]
): Partial<AppState> {
  const batch = createWorktreeTabModelReconciliationBatch(state)
  // Private working copy so batch-owned maps can be written in place.
  const working = { ...state }
  const merged: Partial<AppState> = {}
  for (const worktreeId of worktreeIds) {
    const { patch } = projectWorktreeTabModelReconciliation(working, worktreeId, batch)
    if (Object.keys(patch).length === 0) {
      continue
    }
    Object.assign(merged, patch)
    Object.assign(working, patch)
  }
  return merged
}

export function createTabsSessionActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<
  TabsSlice,
  'reconcileWorktreeTabModel' | 'reconcileWorktreeTabModels' | 'hydrateTabsSession'
> {
  return {
    reconcileWorktreeTabModels: (worktreeIds) => {
      if (worktreeIds.length === 0) {
        return
      }
      const patch = projectWorktreeTabModelReconciliations(get(), worktreeIds)
      if (Object.keys(patch).length > 0) {
        set(patch)
      }
    },

    reconcileWorktreeTabModel: (worktreeId) => {
      const reconciliation = projectWorktreeTabModelReconciliation(get(), worktreeId)
      if (Object.keys(reconciliation.patch).length > 0) {
        set(reconciliation.patch)
      }
      return {
        renderableTabCount: reconciliation.renderableTabCount,
        activeRenderableTabId: reconciliation.activeRenderableTabId
      }
    },

    hydrateTabsSession: (session, options) => {
      const state = get()
      const persistedWorktreeIds = collectPersistedWorktreeIdsForSessionHydration(session)
      const validWorktreeIds = buildValidWorktreeIdsForSessionHydration(state, persistedWorktreeIds)
      validWorktreeIds.add(FLOATING_TERMINAL_WORKTREE_ID)
      for (const workspace of state.folderWorkspaces) {
        validWorktreeIds.add(folderWorkspaceKey(workspace.id))
      }
      addAdditionalValidWorkspaceKeys(validWorktreeIds, options)
      const hydrated = buildHydratedTabState(session, validWorktreeIds)
      if (!options?.replaceWorkspaceKeys) {
        set(hydrated)
        return
      }
      const replaceWorkspaceKeys = new Set(options.replaceWorkspaceKeys)
      set((current) => ({
        unifiedTabsByWorktree: replaceWorkspaceRecordKeys(
          current.unifiedTabsByWorktree,
          hydrated.unifiedTabsByWorktree,
          replaceWorkspaceKeys
        ),
        groupsByWorktree: replaceWorkspaceRecordKeys(
          current.groupsByWorktree,
          hydrated.groupsByWorktree,
          replaceWorkspaceKeys
        ),
        activeGroupIdByWorktree: replaceWorkspaceRecordKeys(
          current.activeGroupIdByWorktree,
          hydrated.activeGroupIdByWorktree,
          replaceWorkspaceKeys
        ),
        layoutByWorktree: replaceWorkspaceRecordKeys(
          current.layoutByWorktree,
          hydrated.layoutByWorktree,
          replaceWorkspaceKeys
        )
      }))
    }
  }
}
