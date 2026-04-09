import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/types'
import type { TabSplitDirection } from './tabs'
import { findTabAndWorktree } from './tabs-helpers'
import { replaceLeaf, buildSplitNode, removeLeaf, findSiblingGroupId } from './tab-group-layout-ops'

type TabsState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
}

type SetGet = {
  set: (fn: (s: TabsState) => Partial<TabsState>) => void
  get: () => TabsState
}

export function createSplitTabToGroup({ set, get }: SetGet) {
  return (tabId: string, direction: TabSplitDirection): void => {
    const state = get()
    // Why: editor/diff tabs reuse the file path as their tab ID, so the same
    // ID can appear in multiple groups after a split. Prefer the focused group
    // to find the correct tab instance — the context menu's pointerDown event
    // focuses the group before the split action fires.
    let found: { tab: Tab; worktreeId: string } | null = null
    for (const [wId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
      const focusedGroupId = state.activeGroupIdByWorktree[wId]
      if (focusedGroupId) {
        const tab = tabs.find((t) => t.id === tabId && t.groupId === focusedGroupId)
        if (tab) {
          found = { tab, worktreeId: wId }
          break
        }
      }
    }
    if (!found) {
      found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
    }
    if (!found) {
      return
    }

    const { tab, worktreeId } = found
    const sourceGroupId = tab.groupId

    // Map user-facing direction to layout tree direction and position
    const splitDirection = direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical'
    // Why: 'left'/'up' = new group appears as the *first* child (before the original),
    // 'right'/'down' = new group appears as the *second* child (after the original).
    const newGroupPosition = direction === 'left' || direction === 'up' ? 'first' : 'second'

    const newGroupId = globalThis.crypto.randomUUID()
    // Why: editor/diff tabs use filePath as their unified tab ID to match the
    // OpenFile entry in EditorSlice. Reusing the source tab's ID lets
    // TabGroupPanel.editorFiles match the OpenFile by ID. Terminal tabs always
    // get a fresh UUID because each terminal has its own PTY lifecycle.
    const newTabId = tab.contentType === 'terminal' ? globalThis.crypto.randomUUID() : tab.id

    const newTab: Tab = {
      id: newTabId,
      groupId: newGroupId,
      worktreeId,
      contentType: tab.contentType,
      label: tab.contentType === 'terminal' ? 'Terminal' : tab.label,
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: Date.now(),
      isPreview: false,
      isPinned: false
    }

    const newGroup: TabGroup = {
      id: newGroupId,
      worktreeId,
      activeTabId: newTabId,
      tabOrder: [newTabId]
    }

    set((s) => {
      // Initialize the layout tree if it doesn't exist yet
      const currentLayout: TabGroupLayoutNode = s.layoutByWorktree[worktreeId] ?? {
        type: 'leaf',
        groupId: sourceGroupId
      }

      const splitNode = buildSplitNode(sourceGroupId, newGroupId, splitDirection, newGroupPosition)
      const newLayout = replaceLeaf(currentLayout, sourceGroupId, splitNode)

      const existingTabs = s.unifiedTabsByWorktree[worktreeId] ?? []
      const existingGroups = s.groupsByWorktree[worktreeId] ?? []

      return {
        unifiedTabsByWorktree: {
          ...s.unifiedTabsByWorktree,
          [worktreeId]: [...existingTabs, newTab]
        },
        groupsByWorktree: {
          ...s.groupsByWorktree,
          [worktreeId]: [...existingGroups, newGroup]
        },
        layoutByWorktree: {
          ...s.layoutByWorktree,
          [worktreeId]: newLayout
        },
        activeGroupIdByWorktree: {
          ...s.activeGroupIdByWorktree,
          [worktreeId]: newGroupId
        }
      }
    })
  }
}

export function createFocusGroup({ set }: Pick<SetGet, 'set'>) {
  return (worktreeId: string, groupId: string): void => {
    set((s) => ({
      activeGroupIdByWorktree: {
        ...s.activeGroupIdByWorktree,
        [worktreeId]: groupId
      }
    }))
  }
}

export function createCloseGroupIfEmpty({ set, get }: SetGet) {
  return (worktreeId: string, groupId: string): void => {
    const state = get()
    const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const groupHasTabs = tabs.some((t) => t.groupId === groupId)
    if (groupHasTabs) {
      return
    }

    const layout = state.layoutByWorktree[worktreeId]
    if (!layout) {
      // No layout tree means single group — just clean up the group record
      set((s) => ({
        groupsByWorktree: {
          ...s.groupsByWorktree,
          [worktreeId]: (s.groupsByWorktree[worktreeId] ?? []).filter((g) => g.id !== groupId)
        }
      }))
      return
    }

    // Find a sibling group to receive focus before removing
    const siblingId = findSiblingGroupId(layout, groupId)
    const collapsed = removeLeaf(layout, groupId)

    set((s) => {
      const nextGroups = (s.groupsByWorktree[worktreeId] ?? []).filter((g) => g.id !== groupId)
      const nextLayout = { ...s.layoutByWorktree }

      // Why: keep a leaf layout even when collapsing to a single group so that
      // TabGroupSplitLayout stays mounted — deleting the layout would unmount
      // TabGroupPanel, destroying xterm instances and killing PTY processes.
      if (!collapsed) {
        delete nextLayout[worktreeId]
      } else {
        nextLayout[worktreeId] = collapsed
      }

      const nextActiveGroup = { ...s.activeGroupIdByWorktree }
      if (s.activeGroupIdByWorktree[worktreeId] === groupId && siblingId) {
        nextActiveGroup[worktreeId] = siblingId
      }

      return {
        groupsByWorktree: { ...s.groupsByWorktree, [worktreeId]: nextGroups },
        layoutByWorktree: nextLayout,
        activeGroupIdByWorktree: nextActiveGroup
      }
    })
  }
}
