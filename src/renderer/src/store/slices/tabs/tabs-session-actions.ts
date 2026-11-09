import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { addAdditionalValidWorkspaceKeys } from '@/lib/workspace/persistence/workspace-session-hydration-keys'
import {
  buildValidWorktreeIdsForSessionHydration,
  collectPersistedWorktreeIdsForSessionHydration
} from '../../../../../shared/worktree/degraded-repo-worktree-validity'
import { buildHydratedTabState } from './tabs-hydration'
import { projectWorktreeTabModelReconciliation } from './tabs-reconciliation'
import { createWorktreeTabModelReconciliationBatch } from './tabs-reconciliation-batch'
import type { AppState } from '../../types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { selectFolderWorkspaces } from '../../workspaces/catalog/workspace-record-fields'
import {
  annotateRecordReplacement,
  annotateTabBucketReplacement,
  markFullResync
} from '../../keyed-record-transitions'

/** The candidate keys whose entry `next` added, deleted or replaced. */
function changedWorkspaceKeys(
  previous: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
  candidates: Iterable<string>
): string[] {
  return [...candidates].filter(
    (key) =>
      Object.hasOwn(previous, key) !== Object.hasOwn(next, key) || previous[key] !== next[key]
  )
}

function replaceWorkspaceRecordKeys<R extends Record<string, unknown>>(
  current: R,
  hydrated: R,
  workspaceKeys: ReadonlySet<string>,
  annotate: (previous: R, next: R, keys: string[]) => R = annotateRecordReplacement
): R {
  const next = {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => !workspaceKeys.has(key))),
    ...Object.fromEntries(Object.entries(hydrated).filter(([key]) => workspaceKeys.has(key)))
  } as R
  return annotate(current, next, changedWorkspaceKeys(current, next, workspaceKeys))
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
  // The fold writes batch-owned drafts in place, so name their keys against the fold's input.
  if (merged.unifiedTabsByWorktree) {
    annotateTabBucketReplacement(
      state.unifiedTabsByWorktree,
      merged.unifiedTabsByWorktree,
      changedWorkspaceKeys(state.unifiedTabsByWorktree, merged.unifiedTabsByWorktree, worktreeIds)
    )
  }
  for (const key of ['groupsByWorktree', 'activeGroupIdByWorktree', 'layoutByWorktree'] as const) {
    const next = merged[key]
    if (next) {
      annotateRecordReplacement(
        state[key],
        next,
        changedWorkspaceKeys(state[key], next, worktreeIds)
      )
    }
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
        // Cold path: a full session hydration rebuilds every workspace's tab state.
        set({
          unifiedTabsByWorktree: markFullResync(hydrated.unifiedTabsByWorktree, 'hydration'),
          groupsByWorktree: markFullResync(hydrated.groupsByWorktree, 'hydration'),
          activeGroupIdByWorktree: markFullResync(hydrated.activeGroupIdByWorktree, 'hydration'),
          layoutByWorktree: markFullResync(hydrated.layoutByWorktree, 'hydration')
        })
        return
      }
      const replaceWorkspaceKeys = new Set(options.replaceWorkspaceKeys)
      set((current) => ({
        unifiedTabsByWorktree: replaceWorkspaceRecordKeys(
          current.unifiedTabsByWorktree,
          hydrated.unifiedTabsByWorktree,
          replaceWorkspaceKeys,
          annotateTabBucketReplacement
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
