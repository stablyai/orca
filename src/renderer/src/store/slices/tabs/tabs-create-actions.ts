import { createBrowserUuid } from '@/lib/browser-uuid'
import { getActiveExecutionHostIdForWorktree } from '@/lib/unified-tab-host-ownership'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { buildActiveSurfacePatch } from './tabs-surface'
import {
  buildSplitNode,
  replaceLeaf
} from '../../../../../shared/workspace-layout/tab-group-layout-tree'
import {
  ensureGroup,
  findGroupForTab,
  pushRecentTabId,
  sanitizeRecentTabIds,
  updateGroup
} from '../tab-group-state'
import {
  applyTabOrderSortValues,
  canReplacePreviewContentType,
  dedupeTabOrder,
  insertTabIdIntoOrder
} from '../../../../../shared/workspace-layout/tab-order'
import { resolveUnifiedTabCreatePlacement } from './tabs-create-placement'
import { folderWorkspaceToWorktree } from '../../../../../shared/folder-workspace-worktree'

export function createTabsCreateActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'createUnifiedTab' | 'createUnifiedTabInSplit'> {
  return {
    createUnifiedTab: (worktreeId, contentType, init) => {
      const id = init?.id ?? createBrowserUuid()
      let created!: Tab
      set((state) => {
        const existingTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
        const placement = resolveUnifiedTabCreatePlacement({
          groups: state.groupsByWorktree[worktreeId] ?? [],
          tabs: existingTabs,
          activeGroupId: state.activeGroupIdByWorktree[worktreeId],
          targetGroupId: init?.targetGroupId,
          afterTabId: init?.afterTabId,
          executionHostId: init?.executionHostId,
          lookupWorktrees: () =>
            [
              ...(state.allWorktrees?.() ?? []),
              ...(state.folderWorkspaces ?? []).map(folderWorkspaceToWorktree)
            ].filter((worktree) => worktree.id === worktreeId)
        })
        const { group, groupsByWorktree, activeGroupIdByWorktree } = ensureGroup(
          state.groupsByWorktree,
          state.activeGroupIdByWorktree,
          worktreeId,
          placement.groupId
        )

        let nextTabs = existingTabs
        let nextOrder = dedupeTabOrder(group.tabOrder)
        if (init?.isPreview) {
          const existingPreview = existingTabs.find(
            (tab) =>
              tab.groupId === group.id &&
              tab.isPreview &&
              canReplacePreviewContentType(contentType, tab.contentType)
          )
          if (existingPreview) {
            nextTabs = existingTabs.filter((tab) => tab.id !== existingPreview.id)
            nextOrder = nextOrder.filter((tabId) => tabId !== existingPreview.id)
          }
        }

        const shouldActivate = init?.activate ?? true
        const recordsFocus = shouldActivate && init?.recordFocus !== false
        const createdAt = Date.now()
        const executionHostId =
          init?.executionHostId ?? getActiveExecutionHostIdForWorktree(state, worktreeId)
        // Why: preview replacement may have removed the anchor; the order then appends in-partition.
        nextOrder = insertTabIdIntoOrder(
          nextOrder,
          nextTabs,
          id,
          init?.isPinned === true,
          placement.anchorTabId
        )
        const insertedIndex = nextOrder.indexOf(id)
        // Why always: preview replacement can leave a gap, so an append alone would reuse a sibling's sortOrder.
        nextTabs = applyTabOrderSortValues(nextTabs, nextOrder)
        created = {
          id,
          entityId: init?.entityId ?? id,
          groupId: group.id,
          worktreeId,
          ...(executionHostId ? { executionHostId } : {}),
          contentType,
          ...(init?.agentSessionAgent ? { agentSessionAgent: init.agentSessionAgent } : {}),
          label:
            init?.label ??
            (contentType === 'terminal' ? `Terminal ${existingTabs.length + 1}` : id),
          ...(init?.generatedLabel !== undefined ? { generatedLabel: init.generatedLabel } : {}),
          ...(init?.quickCommandLabel !== undefined
            ? { quickCommandLabel: init.quickCommandLabel }
            : {}),
          customLabel: init?.customLabel ?? null,
          color: init?.color ?? null,
          sortOrder: insertedIndex,
          createdAt,
          // Why: creating an active tab is a focus event; Cmd+J recency reads lastFocusedAt.
          ...(recordsFocus ? { lastFocusedAt: createdAt } : {}),
          isPreview: init?.isPreview,
          isPinned: init?.isPinned
        }

        const nextActiveTabId = shouldActivate ? created.id : (group.activeTabId ?? created.id)
        const sanitizedRecent = sanitizeRecentTabIds(group.recentTabIds, nextOrder)
        // Why: automation-created browser tabs must paint without stealing the visible group selection from the user's current tab.
        const nextRecent = shouldActivate
          ? pushRecentTabId(sanitizedRecent, created.id)
          : sanitizedRecent
        return {
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [worktreeId]: [...nextTabs, created]
          },
          groupsByWorktree: {
            ...groupsByWorktree,
            [worktreeId]: updateGroup(groupsByWorktree[worktreeId] ?? [], {
              ...group,
              activeTabId: nextActiveTabId,
              tabOrder: nextOrder,
              recentTabIds: nextRecent
            })
          },
          activeGroupIdByWorktree,
          layoutByWorktree: {
            ...state.layoutByWorktree,
            [worktreeId]: state.layoutByWorktree[worktreeId] ?? { type: 'leaf', groupId: group.id }
          }
        }
      })
      if (init?.recordInteraction !== false) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
      return created
    },

    createUnifiedTabInSplit: (worktreeId, contentType, target, init) => {
      const id = init?.id ?? createBrowserUuid()
      const newGroupId = createBrowserUuid()
      let created: Tab | null = null
      let moved = false
      set((state) => {
        const sourceGroup = findGroupForTab(
          state.groupsByWorktree,
          worktreeId,
          target.sourceGroupId
        )
        if (!sourceGroup) {
          return state
        }
        const existingTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
        const currentGroups = state.groupsByWorktree[worktreeId] ?? []
        const shouldActivate = init?.activate ?? true
        const currentLayout =
          state.layoutByWorktree[worktreeId] ??
          ({ type: 'leaf', groupId: target.sourceGroupId } as const)
        const createdAt = Date.now()
        const executionHostId =
          init?.executionHostId ?? getActiveExecutionHostIdForWorktree(state, worktreeId)
        const createdTab: Tab = {
          id,
          entityId: init?.entityId ?? id,
          groupId: newGroupId,
          worktreeId,
          ...(executionHostId ? { executionHostId } : {}),
          contentType,
          ...(init?.agentSessionAgent ? { agentSessionAgent: init.agentSessionAgent } : {}),
          label:
            init?.label ??
            (contentType === 'terminal' ? `Terminal ${existingTabs.length + 1}` : id),
          ...(init?.generatedLabel !== undefined ? { generatedLabel: init.generatedLabel } : {}),
          ...(init?.quickCommandLabel !== undefined
            ? { quickCommandLabel: init.quickCommandLabel }
            : {}),
          customLabel: init?.customLabel ?? null,
          color: init?.color ?? null,
          sortOrder: 0,
          createdAt,
          // Why: creating an active tab is a focus event; Cmd+J recency reads lastFocusedAt.
          ...(shouldActivate ? { lastFocusedAt: createdAt } : {}),
          isPreview: init?.isPreview,
          isPinned: init?.isPinned
        }
        const newGroup: TabGroup = {
          id: newGroupId,
          worktreeId,
          activeTabId: id,
          tabOrder: [id],
          recentTabIds: shouldActivate ? [id] : []
        }
        created = createdTab
        const replacement = buildSplitNode(
          target.sourceGroupId,
          newGroupId,
          target.splitDirection === 'left' || target.splitDirection === 'right'
            ? 'horizontal'
            : 'vertical',
          target.splitDirection === 'left' || target.splitDirection === 'up' ? 'first' : 'second'
        )
        const nextUnifiedTabsByWorktree = {
          ...state.unifiedTabsByWorktree,
          [worktreeId]: [...existingTabs, createdTab]
        }
        const nextGroupsByWorktree = {
          ...state.groupsByWorktree,
          [worktreeId]: [...currentGroups, newGroup]
        }
        const nextLayoutByWorktree = {
          ...state.layoutByWorktree,
          [worktreeId]: replaceLeaf(currentLayout, target.sourceGroupId, replacement)
        }
        const nextActiveGroupIdByWorktree = shouldActivate
          ? {
              ...state.activeGroupIdByWorktree,
              [worktreeId]: newGroupId
            }
          : state.activeGroupIdByWorktree
        moved = true
        return {
          unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
          groupsByWorktree: nextGroupsByWorktree,
          layoutByWorktree: nextLayoutByWorktree,
          activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
          ...(shouldActivate && state.activeWorktreeId === worktreeId
            ? buildActiveSurfacePatch(
                {
                  ...state,
                  unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
                  groupsByWorktree: nextGroupsByWorktree,
                  layoutByWorktree: nextLayoutByWorktree,
                  activeGroupIdByWorktree: nextActiveGroupIdByWorktree
                },
                worktreeId,
                newGroupId
              )
            : {})
        }
      })
      if (created && init?.recordInteraction !== false) {
        get().recordFeatureInteraction?.('terminal-tabs')
      }
      if (moved && init?.recordInteraction !== false) {
        get().recordFeatureInteraction?.('tab-splits')
      }
      return created
    }
  }
}
