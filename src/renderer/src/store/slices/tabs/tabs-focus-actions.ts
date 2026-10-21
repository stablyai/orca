import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import {
  findTabAndWorktree,
  findTabByEntityInGroup,
  pushRecentTabId,
  sanitizeRecentTabIds
} from '../tab-group-state'
import type { Tab } from '../../../../../shared/tab-types'
import type { AppState } from '../../types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { recordPromotedEditorTabsInLayoutOwner } from '../editor/tabs/editor-tab-layout-owner'
import { withPreviewEnded } from './tab-preview-flag'

/** Activation ends a preview unless it preserves it. */
function withPreviewOnActivation(tab: Tab, preservePreview: boolean): Tab {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return { ...tab, isPreview: preservePreview ? tab.isPreview : false }
  }
  return preservePreview ? tab : withPreviewEnded(tab)
}

type ActivationState = Pick<
  AppState,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'activeGroupIdByWorktree'
>

/** The store update that makes `tab` its group's active tab and its group the active one. */
export function tabActivationPatch(
  state: ActivationState,
  tab: Tab,
  worktreeId: string,
  opts?: { preservePreview?: boolean; recordFocus?: boolean }
): ActivationState {
  const tabId = tab.id
  return {
    unifiedTabsByWorktree: {
      ...state.unifiedTabsByWorktree,
      [worktreeId]: (state.unifiedTabsByWorktree[worktreeId] ?? []).map((item) =>
        item.id === tabId
          ? {
              ...withPreviewOnActivation(item, opts?.preservePreview === true),
              ...(opts?.recordFocus === false ? {} : { lastFocusedAt: Date.now() })
            }
          : item
      )
    },
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [worktreeId]: (state.groupsByWorktree[worktreeId] ?? []).map((group) =>
        group.id === tab.groupId
          ? {
              ...group,
              activeTabId: tabId,
              // Why: track every activation in the group's MRU so closeUnifiedTab returns to the previous tab; sanitize to prune removed ids.
              recentTabIds: pushRecentTabId(
                sanitizeRecentTabIds(group.recentTabIds, group.tabOrder),
                tabId
              )
            }
          : group
      )
    },
    activeGroupIdByWorktree: {
      ...state.activeGroupIdByWorktree,
      [worktreeId]: tab.groupId
    }
  }
}

export function createTabsFocusActions(
  _set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'getTab' | 'getActiveTab' | 'findTabForEntityInGroup' | 'activateTab'> {
  const set = _set
  return {
    getTab: (tabId) => findTabAndWorktree(get().unifiedTabsByWorktree, tabId)?.tab ?? null,

    getActiveTab: (worktreeId) => {
      const state = get()
      const groupId = state.activeGroupIdByWorktree[worktreeId]
      const group = (state.groupsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === groupId
      )
      if (!group?.activeTabId) {
        return null
      }
      return (
        (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
          (tab) => tab.id === group.activeTabId
        ) ?? null
      )
    },

    findTabForEntityInGroup: (worktreeId, groupId, entityId, contentType) =>
      findTabByEntityInGroup(
        get().unifiedTabsByWorktree,
        worktreeId,
        groupId,
        entityId,
        contentType
      ),

    activateTab: (tabId, opts) => {
      const promoted: Tab[] = []
      set((state) => {
        const scopedWorktreeId = opts?.worktreeId
        let found: ReturnType<typeof findTabAndWorktree>
        if (scopedWorktreeId !== undefined) {
          const scopedTabs = Object.hasOwn(state.unifiedTabsByWorktree, scopedWorktreeId)
            ? state.unifiedTabsByWorktree[scopedWorktreeId]
            : []
          const scopedTab = scopedTabs.find((tab) => tab.id === tabId)
          found = scopedTab ? { tab: scopedTab, worktreeId: scopedWorktreeId } : null
        } else {
          found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
        }
        if (!found) {
          return state
        }
        const { tab, worktreeId } = found
        if (ORCA_LAYOUT_OWNER_IS_MAIN && tab.isPreview && !opts?.preservePreview) {
          promoted.push(tab)
        }
        return tabActivationPatch(state, tab, worktreeId, opts)
      })
      // Switch point: main records that activating a preview made it permanent.
      if (ORCA_LAYOUT_OWNER_IS_MAIN && promoted.length > 0) {
        recordPromotedEditorTabsInLayoutOwner(get(), promoted)
      }
    }
  }
}
