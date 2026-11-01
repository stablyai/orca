import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { addAdditionalValidWorkspaceKeys } from '@/lib/workspace-session-hydration-keys'
import {
  buildValidWorktreeIdsForSessionHydration,
  collectPersistedWorktreeIdsForSessionHydration
} from '../../../../../shared/worktree/degraded-repo-worktree-validity'
import { buildHydratedTabState } from '../tabs-hydration'
import { projectWorktreeTabModelReconciliation } from './tabs-reconciliation'
import { createWorktreeTabModelReconciliationBatch } from './tabs-reconciliation-batch'
import type { AppState } from '../../types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { selectFolderWorkspaces } from '../../workspace-record-selectors'

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

/** Fold in workspace order so shared unread/orphan maps see prior patches; defer only the store write and subscriber notifications. */
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
      // Switch point: main's frames draw the tab bar, so reconcile writes no structure of its own.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        return
      }
      const patch = projectWorktreeTabModelReconciliations(get(), worktreeIds)
      if (Object.keys(patch).length > 0) {
        set(patch)
      }
    },

    reconcileWorktreeTabModel: (worktreeId) => {
      const reconciliation = projectWorktreeTabModelReconciliation(get(), worktreeId)
      // Switch point: the counts only; main's frames draw the tab bar.
      if (!ORCA_LAYOUT_OWNER_IS_MAIN && Object.keys(reconciliation.patch).length > 0) {
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
      for (const workspace of selectFolderWorkspaces(state)) {
        validWorktreeIds.add(folderWorkspaceKey(workspace.id))
      }
      addAdditionalValidWorkspaceKeys(validWorktreeIds, options)
      const hydrated = buildHydratedTabState(
        session,
        validWorktreeIds,
        undefined,
        new Set(options?.wslMovedChatWorkspaceKeys)
      )
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
