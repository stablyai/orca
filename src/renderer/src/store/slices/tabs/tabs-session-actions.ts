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
  // Why per worktree: an unowned editor id is the bare file path, so the same id can name a live
  // document in another workspace — a flat set of orphans would sweep that one too.
  const orphanEditorFileIdsByWorktree = new Map<string, Set<string>>()
  for (const worktreeId of worktreeIds) {
    const reconciliation = projectWorktreeTabModelReconciliation(working, worktreeId, batch)
    if (reconciliation.orphanEditorFileIds.length > 0) {
      orphanEditorFileIdsByWorktree.set(worktreeId, new Set(reconciliation.orphanEditorFileIds))
    }
    if (Object.keys(reconciliation.patch).length === 0) {
      continue
    }
    Object.assign(merged, reconciliation.patch)
    Object.assign(working, reconciliation.patch)
  }
  // Why only here: `openFiles` is written once the whole fold is projected, so the batch's
  // one-shot editor index stays valid — and an unsaved buffer is never swept.
  if (orphanEditorFileIdsByWorktree.size > 0) {
    // Why the draft check: isDirty is set by a debounced callback, so a just-typed buffer can hold
    // a draft before the flag flushes — sweeping it would discard the user's text.
    const sweptFileIdsByWorktree = new Map<string, Set<string>>()
    for (const file of state.openFiles) {
      if (
        file.isDirty === true ||
        state.editorDrafts[file.id] !== undefined ||
        orphanEditorFileIdsByWorktree.get(file.worktreeId)?.has(file.id) !== true
      ) {
        continue
      }
      const swept = sweptFileIdsByWorktree.get(file.worktreeId)
      if (swept) {
        swept.add(file.id)
        continue
      }
      sweptFileIdsByWorktree.set(file.worktreeId, new Set([file.id]))
    }
    if (sweptFileIdsByWorktree.size > 0) {
      merged.openFiles = state.openFiles.filter(
        (file) => sweptFileIdsByWorktree.get(file.worktreeId)?.has(file.id) !== true
      )
      const tabBarOrder = pruneTabBarOrderEntries(
        working.tabBarOrderByWorktree ?? state.tabBarOrderByWorktree,
        sweptFileIdsByWorktree
      )
      if (tabBarOrder) {
        merged.tabBarOrderByWorktree = tabBarOrder
      }
    }
  }
  return merged
}

/** Why: a swept id left in the strip order still shifts positions on the next reconcile. */
function pruneTabBarOrderEntries(
  tabBarOrderByWorktree: AppState['tabBarOrderByWorktree'],
  sweptFileIdsByWorktree: ReadonlyMap<string, ReadonlySet<string>>
): AppState['tabBarOrderByWorktree'] | null {
  if (!tabBarOrderByWorktree) {
    return null
  }
  let changed = false
  const next: AppState['tabBarOrderByWorktree'] = {}
  for (const [worktreeId, order] of Object.entries(tabBarOrderByWorktree)) {
    const sweptFileIds = sweptFileIdsByWorktree.get(worktreeId)
    const pruned = sweptFileIds ? order.filter((entryId) => !sweptFileIds.has(entryId)) : order
    changed = changed || pruned.length !== order.length
    next[worktreeId] = pruned.length === order.length ? order : pruned
  }
  return changed ? next : null
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

    // Why no orphan prune here: this runs from setActiveWorktree and empty-group checks, which can
    // observe an in-flight open (the OpenFile is published before its tab), so pruning would delete
    // a live document — only the batch fold at the hydration boundary sees a settled tab model.
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
