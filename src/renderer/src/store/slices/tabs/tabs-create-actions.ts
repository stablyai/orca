import { createBrowserUuid } from '@/lib/browser-uuid'
import { getActiveExecutionHostIdForWorktree } from '@/lib/unified-tab-host-ownership'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { buildActiveSurfacePatch } from './tabs-surface'
import { buildSplitNode, replaceLeaf } from './tabs-layout'
import {
  dedupeTabOrder,
  ensureGroup,
  findGroupForTab,
  pushRecentTabId,
  sanitizeRecentTabIds,
  updateGroup
} from '../tab-group-state'
import { canReplacePreviewContentType } from './tabs-tab-order'

export function createTabsCreateActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'createUnifiedTab' | 'createUnifiedTabInSplit'> {
  return {
    createUnifiedTab: (worktreeId, contentType, init) => {
      const id = init?.id ?? createBrowserUuid()
      let created!: Tab
      set((state) => {
        const { group, groupsByWorktree, activeGroupIdByWorktree } = ensureGroup(
          state.groupsByWorktree,
          state.activeGroupIdByWorktree,
          worktreeId,
          init?.targetGroupId ?? state.activeGroupIdByWorktree[worktreeId]
        )
        const existingTabs = state.unifiedTabsByWorktree[worktreeId] ?? []

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
        const createdAt = Date.now()
        const executionHostId =
          init?.executionHostId ?? getActiveExecutionHostIdForWorktree(state, worktreeId)
        created = {
          id,
          entityId: init?.entityId ?? id,
          groupId: group.id,
          worktreeId,
          ...(executionHostId ? { executionHostId } : {}),
          contentType,
          label:
            init?.label ??
            (contentType === 'terminal' ? `Terminal ${existingTabs.length + 1}` : id),
          ...(init?.generatedLabel !== undefined ? { generatedLabel: init.generatedLabel } : {}),
          ...(init?.quickCommandLabel !== undefined
            ? { quickCommandLabel: init.quickCommandLabel }
            : {}),
          customLabel: init?.customLabel ?? null,
          color: init?.color ?? null,
          sortOrder: nextOrder.length,
          createdAt,
          // Why: creating an active tab is a focus event; Cmd+J recency reads lastFocusedAt.
          ...(shouldActivate ? { lastFocusedAt: createdAt } : {}),
          isPreview: init?.isPreview,
          isPinned: init?.isPinned
        }

        nextOrder = dedupeTabOrder([...nextOrder, created.id])
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
          return {}
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
