import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  Tab,
  TabGroup,
  TabContentType,
  TabGroupLayoutNode,
  WorkspaceSessionState
} from '../../../../shared/types'
import {
  findTabAndWorktree,
  findGroupForTab,
  ensureGroup,
  pickNeighbor,
  updateGroup,
  patchTab
} from './tabs-helpers'
import { buildHydratedTabState } from './tabs-hydration'
import {
  createSplitTabToGroup,
  createFocusGroup,
  createCloseGroupIfEmpty
} from './tabs-split-actions'
import { createCloseOtherTabs, createCloseTabsToRight } from './tabs-bulk-actions'

export type TabSplitDirection = 'left' | 'right' | 'up' | 'down'

export type TabsSlice = {
  // ─── State ──────────────────────────────────────────────────────────
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  layoutByWorktree: Record<string, TabGroupLayoutNode>

  // ─── Actions ────────────────────────────────────────────────────────
  createUnifiedTab: (
    worktreeId: string,
    contentType: TabContentType,
    init?: Partial<Pick<Tab, 'id' | 'label' | 'customLabel' | 'color' | 'isPreview' | 'isPinned'>>
  ) => Tab
  closeUnifiedTab: (
    tabId: string,
    groupId?: string
  ) => { closedTabId: string; wasLastTab: boolean; worktreeId: string } | null
  activateTab: (tabId: string) => void
  reorderUnifiedTabs: (groupId: string, tabIds: string[]) => void
  setTabLabel: (tabId: string, label: string) => void
  setTabCustomLabel: (tabId: string, label: string | null) => void
  setUnifiedTabColor: (tabId: string, color: string | null) => void
  pinTab: (tabId: string) => void
  unpinTab: (tabId: string) => void
  closeOtherTabs: (tabId: string) => string[]
  closeTabsToRight: (tabId: string) => string[]
  getActiveTab: (worktreeId: string) => Tab | null
  getTab: (tabId: string) => Tab | null
  hydrateTabsSession: (session: WorkspaceSessionState) => void
  splitTabToGroup: (tabId: string, direction: TabSplitDirection) => void
  focusGroup: (worktreeId: string, groupId: string) => void
  closeGroupIfEmpty: (worktreeId: string, groupId: string) => void
}

export const createTabsSlice: StateCreator<AppState, [], [], TabsSlice> = (set, get) => ({
  unifiedTabsByWorktree: {},
  groupsByWorktree: {},
  activeGroupIdByWorktree: {},
  layoutByWorktree: {},

  createUnifiedTab: (worktreeId, contentType, init) => {
    const id = init?.id ?? globalThis.crypto.randomUUID()
    let tab!: Tab

    set((s) => {
      // Why: pass the active (focused) group so new tabs land in the group
      // the user is interacting with, not an arbitrary first group.
      const targetGroupId = s.activeGroupIdByWorktree[worktreeId]
      const {
        group,
        groupsByWorktree: nextGroups,
        activeGroupIdByWorktree: nextActiveGroups
      } = ensureGroup(s.groupsByWorktree, s.activeGroupIdByWorktree, worktreeId, targetGroupId)

      const existing = s.unifiedTabsByWorktree[worktreeId] ?? []

      // If opening a preview tab, replace any existing preview in the same group
      let filtered = existing
      let removedPreviewId: string | null = null
      if (init?.isPreview) {
        const existingPreview = existing.find((t) => t.isPreview && t.groupId === group.id)
        if (existingPreview) {
          // Why: filter by both id AND groupId so editor tabs with the same
          // filePath ID in other groups are not accidentally removed.
          filtered = existing.filter(
            (t) => !(t.id === existingPreview.id && t.groupId === existingPreview.groupId)
          )
          removedPreviewId = existingPreview.id
        }
      }

      tab = {
        id,
        groupId: group.id,
        worktreeId,
        contentType,
        label: init?.label ?? (contentType === 'terminal' ? `Terminal ${existing.length + 1}` : id),
        customLabel: init?.customLabel ?? null,
        color: init?.color ?? null,
        sortOrder: filtered.length,
        createdAt: Date.now(),
        isPreview: init?.isPreview,
        isPinned: init?.isPinned
      }

      const newTabOrder = removedPreviewId
        ? group.tabOrder.filter((tid) => tid !== removedPreviewId)
        : [...group.tabOrder]
      newTabOrder.push(tab.id)

      const updatedGroupObj: TabGroup = { ...group, activeTabId: tab.id, tabOrder: newTabOrder }

      // Why: always ensure a layout exists so TabGroupSplitLayout can render
      // for every worktree, even before a split. This avoids the single-group
      // → split-group rendering transition that would unmount TerminalPanes.
      const nextLayout = s.layoutByWorktree[worktreeId]
        ? s.layoutByWorktree
        : { ...s.layoutByWorktree, [worktreeId]: { type: 'leaf' as const, groupId: group.id } }

      return {
        unifiedTabsByWorktree: { ...s.unifiedTabsByWorktree, [worktreeId]: [...filtered, tab] },
        groupsByWorktree: {
          ...nextGroups,
          [worktreeId]: updateGroup(nextGroups[worktreeId] ?? [], updatedGroupObj)
        },
        activeGroupIdByWorktree: nextActiveGroups,
        layoutByWorktree: nextLayout
      }
    })

    return tab
  },

  closeUnifiedTab: (tabId, groupId?) => {
    const state = get()
    const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId, groupId)
    if (!found) {
      return null
    }

    const { tab, worktreeId } = found
    const group = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
    if (!group) {
      return null
    }

    const remainingOrder = group.tabOrder.filter((tid) => tid !== tabId)
    const wasLastTab = remainingOrder.length === 0

    let newActiveTabId = group.activeTabId
    if (group.activeTabId === tabId) {
      newActiveTabId = wasLastTab ? null : pickNeighbor(group.tabOrder, tabId)
    }

    set((s) => {
      const tabs = s.unifiedTabsByWorktree[worktreeId] ?? []
      // Why: editor tabs can share the same ID (filePath) across groups.
      // Filter by both id and groupId to only remove the tab from this group.
      const nextTabs = tabs.filter((t) => !(t.id === tabId && t.groupId === tab.groupId))
      const updatedGroupObj: TabGroup = {
        ...group,
        activeTabId: newActiveTabId,
        tabOrder: remainingOrder
      }

      return {
        unifiedTabsByWorktree: { ...s.unifiedTabsByWorktree, [worktreeId]: nextTabs },
        groupsByWorktree: {
          ...s.groupsByWorktree,
          [worktreeId]: updateGroup(s.groupsByWorktree[worktreeId] ?? [], updatedGroupObj)
        }
      }
    })

    // Why: when the last tab in a group is closed, collapse the layout tree
    // so the empty group disappears and its sibling fills the space.
    if (wasLastTab) {
      get().closeGroupIfEmpty(worktreeId, tab.groupId)
    }

    return { closedTabId: tabId, wasLastTab, worktreeId }
  },

  activateTab: (tabId) => {
    set((s) => {
      // Why: editor/diff tabs share the same ID (filePath) across groups.
      // Prefer the focused group so we activate the correct group's tab.
      let found: { tab: Tab; worktreeId: string } | null = null
      for (const [wId, tabs] of Object.entries(s.unifiedTabsByWorktree)) {
        const focusedGroupId = s.activeGroupIdByWorktree[wId]
        if (focusedGroupId) {
          const tab = tabs.find((t) => t.id === tabId && t.groupId === focusedGroupId)
          if (tab) {
            found = { tab, worktreeId: wId }
            break
          }
        }
      }
      if (!found) {
        found = findTabAndWorktree(s.unifiedTabsByWorktree, tabId)
      }
      if (!found) {
        return {}
      }

      const { tab, worktreeId } = found
      const groups = s.groupsByWorktree[worktreeId] ?? []
      const updatedGroups = groups.map((g) =>
        g.id === tab.groupId ? { ...g, activeTabId: tabId } : g
      )

      let updatedTabs = s.unifiedTabsByWorktree[worktreeId]
      if (tab.isPreview) {
        updatedTabs = updatedTabs.map((t) => (t.id === tabId ? { ...t, isPreview: false } : t))
      }

      return {
        unifiedTabsByWorktree: { ...s.unifiedTabsByWorktree, [worktreeId]: updatedTabs },
        groupsByWorktree: { ...s.groupsByWorktree, [worktreeId]: updatedGroups }
      }
    })
  },

  reorderUnifiedTabs: (groupId, tabIds) => {
    set((s) => {
      for (const [worktreeId, groups] of Object.entries(s.groupsByWorktree)) {
        const group = groups.find((g) => g.id === groupId)
        if (!group) {
          continue
        }

        const updatedGroupObj: TabGroup = { ...group, tabOrder: tabIds }
        const tabs = s.unifiedTabsByWorktree[worktreeId] ?? []
        const orderMap = new Map(tabIds.map((id, i) => [id, i]))
        const updatedTabs = tabs.map((t) => {
          const newOrder = orderMap.get(t.id)
          return newOrder !== undefined ? { ...t, sortOrder: newOrder } : t
        })

        return {
          groupsByWorktree: {
            ...s.groupsByWorktree,
            [worktreeId]: updateGroup(groups, updatedGroupObj)
          },
          unifiedTabsByWorktree: { ...s.unifiedTabsByWorktree, [worktreeId]: updatedTabs }
        }
      }
      return {}
    })
  },

  setTabLabel: (tabId, label) => {
    set((s) => patchTab(s.unifiedTabsByWorktree, tabId, { label }) ?? {})
  },

  setTabCustomLabel: (tabId, label) => {
    set((s) => patchTab(s.unifiedTabsByWorktree, tabId, { customLabel: label }) ?? {})
  },

  setUnifiedTabColor: (tabId, color) => {
    set((s) => patchTab(s.unifiedTabsByWorktree, tabId, { color }) ?? {})
  },

  pinTab: (tabId) => {
    set((s) => patchTab(s.unifiedTabsByWorktree, tabId, { isPinned: true, isPreview: false }) ?? {})
  },

  unpinTab: (tabId) => {
    set((s) => patchTab(s.unifiedTabsByWorktree, tabId, { isPinned: false }) ?? {})
  },

  closeOtherTabs: createCloseOtherTabs({ set, get }),
  closeTabsToRight: createCloseTabsToRight({ set, get }),

  getActiveTab: (worktreeId) => {
    const state = get()
    const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
    if (!activeGroupId) {
      return null
    }

    const groups = state.groupsByWorktree[worktreeId] ?? []
    const group = groups.find((g) => g.id === activeGroupId)
    if (!group?.activeTabId) {
      return null
    }

    const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    return tabs.find((t) => t.id === group.activeTabId) ?? null
  },

  getTab: (tabId) => {
    const state = get()
    const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
    return found?.tab ?? null
  },

  hydrateTabsSession: (session) => {
    const state = get()
    const validWorktreeIds = new Set(
      Object.values(state.worktreesByRepo)
        .flat()
        .map((w) => w.id)
    )
    set(buildHydratedTabState(session, validWorktreeIds))
  },

  splitTabToGroup: createSplitTabToGroup({ set, get }),
  focusGroup: createFocusGroup({ set }),
  closeGroupIfEmpty: createCloseGroupIfEmpty({ set, get })
})
