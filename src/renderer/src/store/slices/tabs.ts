/* eslint-disable max-lines -- Why: split-tab group state has to update layout, per-group focus, tab membership, and session hydration atomically. Keeping those transitions in one slice avoids split-brain behavior between the workspace item model and the legacy content slices. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  Tab,
  TabContentType,
  TabGroup,
  TabGroupLayoutNode,
  WorkspaceSessionState
} from '../../../../shared/types'
import {
  ensureGroup,
  findGroupForTab,
  findTabAndWorktree,
  findTabByEntityInGroup,
  getPersistedEditFileIdsByWorktree,
  isTransientEditorContentType,
  patchTab,
  pickNeighbor,
  selectHydratedActiveGroupId,
  updateGroup
} from './tabs-helpers'
import { captureAllTerminalBuffers } from '../../components/terminal-pane/buffer-capture-registry'

export type TabSplitDirection = 'left' | 'right' | 'up' | 'down'

export type TabsSlice = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
  createUnifiedTab: (
    worktreeId: string,
    contentType: TabContentType,
    init: {
      entityId?: string
      id?: string
      label: string
      customLabel?: string | null
      color?: string | null
      isPreview?: boolean
      isPinned?: boolean
      targetGroupId?: string
    }
  ) => Tab
  getTab: (tabId: string) => Tab | null
  getActiveTab: (worktreeId: string) => Tab | null
  findTabForEntityInGroup: (
    worktreeId: string,
    groupId: string,
    entityId: string,
    contentType?: TabContentType
  ) => Tab | null
  activateTab: (tabId: string) => void
  closeUnifiedTab: (
    tabId: string
  ) => { closedTabId: string; wasLastTab: boolean; worktreeId: string } | null
  reorderUnifiedTabs: (groupId: string, tabIds: string[]) => void
  setTabLabel: (tabId: string, label: string) => void
  setTabCustomLabel: (tabId: string, label: string | null) => void
  setUnifiedTabColor: (tabId: string, color: string | null) => void
  pinTab: (tabId: string) => void
  unpinTab: (tabId: string) => void
  closeOtherTabs: (tabId: string) => string[]
  closeTabsToRight: (tabId: string) => string[]
  ensureWorktreeRootGroup: (worktreeId: string) => string
  focusGroup: (worktreeId: string, groupId: string) => void
  closeEmptyGroup: (worktreeId: string, groupId: string) => boolean
  createEmptySplitGroup: (
    worktreeId: string,
    sourceGroupId: string,
    direction: TabSplitDirection
  ) => string | null
  hydrateTabsSession: (session: WorkspaceSessionState) => void
}

function buildSplitNode(
  existingGroupId: string,
  newGroupId: string,
  direction: 'horizontal' | 'vertical',
  position: 'first' | 'second'
): TabGroupLayoutNode {
  const existingLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: existingGroupId }
  const newLeaf: TabGroupLayoutNode = { type: 'leaf', groupId: newGroupId }
  return {
    type: 'split',
    direction,
    first: position === 'first' ? newLeaf : existingLeaf,
    second: position === 'second' ? newLeaf : existingLeaf
  }
}

function replaceLeaf(
  root: TabGroupLayoutNode,
  targetGroupId: string,
  replacement: TabGroupLayoutNode
): TabGroupLayoutNode {
  if (root.type === 'leaf') {
    return root.groupId === targetGroupId ? replacement : root
  }
  return {
    ...root,
    first: replaceLeaf(root.first, targetGroupId, replacement),
    second: replaceLeaf(root.second, targetGroupId, replacement)
  }
}

function findSiblingGroupId(root: TabGroupLayoutNode, targetGroupId: string): string | null {
  if (root.type === 'leaf') {
    return null
  }
  if (root.first.type === 'leaf' && root.first.groupId === targetGroupId) {
    return root.second.type === 'leaf' ? root.second.groupId : findFirstLeaf(root.second)
  }
  if (root.second.type === 'leaf' && root.second.groupId === targetGroupId) {
    return root.first.type === 'leaf' ? root.first.groupId : findFirstLeaf(root.first)
  }
  return (
    findSiblingGroupId(root.first, targetGroupId) ?? findSiblingGroupId(root.second, targetGroupId)
  )
}

function findFirstLeaf(root: TabGroupLayoutNode): string {
  return root.type === 'leaf' ? root.groupId : findFirstLeaf(root.first)
}

function removeLeaf(root: TabGroupLayoutNode, targetGroupId: string): TabGroupLayoutNode | null {
  if (root.type === 'leaf') {
    return root.groupId === targetGroupId ? null : root
  }
  if (root.first.type === 'leaf' && root.first.groupId === targetGroupId) {
    return root.second
  }
  if (root.second.type === 'leaf' && root.second.groupId === targetGroupId) {
    return root.first
  }
  const first = removeLeaf(root.first, targetGroupId)
  const second = removeLeaf(root.second, targetGroupId)
  if (first === null) {
    return second
  }
  if (second === null) {
    return first
  }
  return { ...root, first, second }
}

function collapseGroupLayout(
  layoutByWorktree: Record<string, TabGroupLayoutNode>,
  activeGroupIdByWorktree: Record<string, string>,
  worktreeId: string,
  groupId: string,
  fallbackGroupId?: string | null
): {
  layoutByWorktree: Record<string, TabGroupLayoutNode>
  activeGroupIdByWorktree: Record<string, string>
} {
  const currentLayout = layoutByWorktree[worktreeId]
  if (!currentLayout) {
    return { layoutByWorktree, activeGroupIdByWorktree }
  }
  const siblingId = findSiblingGroupId(currentLayout, groupId)
  const collapsed = removeLeaf(currentLayout, groupId)
  const nextLayoutByWorktree = { ...layoutByWorktree }
  if (collapsed) {
    nextLayoutByWorktree[worktreeId] = collapsed
  } else {
    delete nextLayoutByWorktree[worktreeId]
  }
  return {
    layoutByWorktree: nextLayoutByWorktree,
    activeGroupIdByWorktree: {
      ...activeGroupIdByWorktree,
      [worktreeId]: siblingId ?? fallbackGroupId ?? activeGroupIdByWorktree[worktreeId]
    }
  }
}

function hydrateTabsState(session: WorkspaceSessionState, validWorktreeIds: Set<string>) {
  const unifiedTabsByWorktree: Record<string, Tab[]> = {}
  const groupsByWorktree: Record<string, TabGroup[]> = {}
  const activeGroupIdByWorktree: Record<string, string> = {}
  const layoutByWorktree: Record<string, TabGroupLayoutNode> = {}

  if (session.unifiedTabs && session.tabGroups) {
    const persistedEditFileIdsByWorktree = getPersistedEditFileIdsByWorktree(session)
    for (const [worktreeId, tabs] of Object.entries(session.unifiedTabs)) {
      if (!validWorktreeIds.has(worktreeId) || tabs.length === 0) {
        continue
      }
      const persistedEditFileIds = persistedEditFileIdsByWorktree[worktreeId] ?? new Set<string>()
      unifiedTabsByWorktree[worktreeId] = tabs
        .map((tab) => ({
          ...tab,
          entityId: tab.entityId ?? tab.id
        }))
        .filter((tab) => {
          if (!isTransientEditorContentType(tab.contentType)) {
            return true
          }
          // Why: workspace session restore intentionally skips transient diff
          // and conflict-review OpenFiles. If their unified tab instances are
          // kept anyway, split groups restore chrome for panes that have no
          // backing editor state and render blank content after restart.
          return persistedEditFileIds.has(tab.entityId)
        })
    }
    for (const [worktreeId, groups] of Object.entries(session.tabGroups)) {
      if (!validWorktreeIds.has(worktreeId) || groups.length === 0) {
        continue
      }
      const validTabIds = new Set((unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
      groupsByWorktree[worktreeId] = groups.map((group) => {
        const tabOrder = group.tabOrder.filter((tabId) => validTabIds.has(tabId))
        return {
          ...group,
          tabOrder,
          // Why: restore can drop transient tabs that no longer have backing
          // editor state. Promote the first surviving tab so the hydrated group
          // still renders content immediately instead of coming back blank.
          activeTabId:
            group.activeTabId && validTabIds.has(group.activeTabId)
              ? group.activeTabId
              : (tabOrder[0] ?? null)
        }
      })
      const activeGroupId = selectHydratedActiveGroupId(
        groupsByWorktree[worktreeId],
        session.activeGroupIdByWorktree?.[worktreeId]
      )
      if (activeGroupId) {
        activeGroupIdByWorktree[worktreeId] = activeGroupId
      }
      layoutByWorktree[worktreeId] = session.tabGroupLayouts?.[worktreeId] ?? {
        type: 'leaf',
        groupId: groupsByWorktree[worktreeId][0].id
      }
    }
    return { unifiedTabsByWorktree, groupsByWorktree, activeGroupIdByWorktree, layoutByWorktree }
  }

  for (const worktreeId of validWorktreeIds) {
    const terminalTabs = session.tabsByWorktree[worktreeId] ?? []
    const editorFiles = session.openFilesByWorktree?.[worktreeId] ?? []
    if (terminalTabs.length === 0 && editorFiles.length === 0) {
      continue
    }
    const groupId = globalThis.crypto.randomUUID()
    const items: Tab[] = []
    const tabOrder: string[] = []
    for (const terminal of terminalTabs) {
      items.push({
        id: terminal.id,
        entityId: terminal.id,
        groupId,
        worktreeId,
        contentType: 'terminal',
        label: terminal.title,
        customLabel: terminal.customTitle,
        color: terminal.color,
        sortOrder: items.length,
        createdAt: terminal.createdAt
      })
      tabOrder.push(terminal.id)
    }
    for (const editorFile of editorFiles) {
      const itemId = globalThis.crypto.randomUUID()
      items.push({
        id: itemId,
        entityId: editorFile.filePath,
        groupId,
        worktreeId,
        contentType: 'editor',
        label: editorFile.relativePath,
        customLabel: null,
        color: null,
        sortOrder: items.length,
        createdAt: Date.now(),
        isPreview: editorFile.isPreview
      })
      tabOrder.push(itemId)
    }
    unifiedTabsByWorktree[worktreeId] = items
    groupsByWorktree[worktreeId] = [
      {
        id: groupId,
        worktreeId,
        activeTabId: tabOrder[0] ?? null,
        tabOrder
      }
    ]
    activeGroupIdByWorktree[worktreeId] = groupId
    layoutByWorktree[worktreeId] = { type: 'leaf', groupId }
  }

  return { unifiedTabsByWorktree, groupsByWorktree, activeGroupIdByWorktree, layoutByWorktree }
}

export const createTabsSlice: StateCreator<AppState, [], [], TabsSlice> = (set, get) => ({
  unifiedTabsByWorktree: {},
  groupsByWorktree: {},
  activeGroupIdByWorktree: {},
  layoutByWorktree: {},

  createUnifiedTab: (worktreeId, contentType, init) => {
    const id = init.id ?? globalThis.crypto.randomUUID()
    let created!: Tab
    set((state) => {
      const { group, groupsByWorktree, activeGroupIdByWorktree } = ensureGroup(
        state.groupsByWorktree,
        state.activeGroupIdByWorktree,
        worktreeId,
        init.targetGroupId ?? state.activeGroupIdByWorktree[worktreeId]
      )
      const existingTabs = state.unifiedTabsByWorktree[worktreeId] ?? []

      let nextTabs = existingTabs
      let nextOrder = [...group.tabOrder]
      if (init.isPreview) {
        const existingPreview = existingTabs.find(
          (tab) => tab.groupId === group.id && tab.isPreview && tab.contentType === contentType
        )
        if (existingPreview) {
          nextTabs = existingTabs.filter((tab) => tab.id !== existingPreview.id)
          nextOrder = nextOrder.filter((tabId) => tabId !== existingPreview.id)
        }
      }

      created = {
        id,
        entityId: init.entityId ?? id,
        groupId: group.id,
        worktreeId,
        contentType,
        label: init.label,
        customLabel: init.customLabel ?? null,
        color: init.color ?? null,
        sortOrder: nextOrder.length,
        createdAt: Date.now(),
        isPreview: init.isPreview,
        isPinned: init.isPinned
      }

      nextOrder.push(created.id)
      return {
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [worktreeId]: [...nextTabs, created]
        },
        groupsByWorktree: {
          ...groupsByWorktree,
          [worktreeId]: updateGroup(groupsByWorktree[worktreeId] ?? [], {
            ...group,
            activeTabId: created.id,
            tabOrder: nextOrder
          })
        },
        activeGroupIdByWorktree,
        layoutByWorktree: {
          ...state.layoutByWorktree,
          [worktreeId]: state.layoutByWorktree[worktreeId] ?? { type: 'leaf', groupId: group.id }
        }
      }
    })
    return created
  },

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
      (state.unifiedTabsByWorktree[worktreeId] ?? []).find((tab) => tab.id === group.activeTabId) ??
      null
    )
  },

  findTabForEntityInGroup: (worktreeId, groupId, entityId, contentType) =>
    findTabByEntityInGroup(get().unifiedTabsByWorktree, worktreeId, groupId, entityId, contentType),

  activateTab: (tabId) => {
    set((state) => {
      const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!found) {
        return {}
      }
      const { tab, worktreeId } = found
      return {
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [worktreeId]: (state.unifiedTabsByWorktree[worktreeId] ?? []).map((item) =>
            item.id === tabId ? { ...item, isPreview: false } : item
          )
        },
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [worktreeId]: (state.groupsByWorktree[worktreeId] ?? []).map((group) =>
            group.id === tab.groupId ? { ...group, activeTabId: tabId } : group
          )
        },
        activeGroupIdByWorktree: {
          ...state.activeGroupIdByWorktree,
          [worktreeId]: tab.groupId
        }
      }
    })
  },

  closeUnifiedTab: (tabId) => {
    const state = get()
    const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
    if (!found) {
      return null
    }
    const { tab, worktreeId } = found
    const group = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
    if (!group) {
      return null
    }
    const remainingOrder = group.tabOrder.filter((id) => id !== tabId)
    const wasLastTab = remainingOrder.length === 0
    const nextActiveTabId =
      group.activeTabId === tabId
        ? wasLastTab
          ? null
          : pickNeighbor(group.tabOrder, tabId)
        : group.activeTabId

    if (wasLastTab && state.layoutByWorktree[worktreeId]) {
      // Why: collapsing a split group remounts the surviving terminal pane
      // tree. Capture buffers before changing layout so the next mount sees the
      // latest prompt line instead of racing an unmount-time snapshot.
      captureAllTerminalBuffers()
    }

    set((current) => {
      const nextTabs = (current.unifiedTabsByWorktree[worktreeId] ?? []).filter(
        (item) => item.id !== tabId
      )
      const nextGroups = (current.groupsByWorktree[worktreeId] ?? []).map((candidate) =>
        candidate.id === group.id
          ? { ...candidate, activeTabId: nextActiveTabId, tabOrder: remainingOrder }
          : candidate
      )
      let nextLayoutByWorktree = current.layoutByWorktree
      let nextActiveGroupIdByWorktree = current.activeGroupIdByWorktree
      if (wasLastTab && current.layoutByWorktree[worktreeId]) {
        const nextCollapsedState = collapseGroupLayout(
          current.layoutByWorktree,
          current.activeGroupIdByWorktree,
          worktreeId,
          group.id,
          nextGroups[0]?.id ?? null
        )
        nextLayoutByWorktree = nextCollapsedState.layoutByWorktree
        nextActiveGroupIdByWorktree = nextCollapsedState.activeGroupIdByWorktree
      }
      return {
        unifiedTabsByWorktree: { ...current.unifiedTabsByWorktree, [worktreeId]: nextTabs },
        groupsByWorktree: {
          ...current.groupsByWorktree,
          [worktreeId]: wasLastTab
            ? nextGroups.filter((candidate) => candidate.id !== group.id)
            : nextGroups
        },
        layoutByWorktree: nextLayoutByWorktree,
        activeGroupIdByWorktree: nextActiveGroupIdByWorktree
      }
    })

    return { closedTabId: tabId, wasLastTab, worktreeId }
  },

  reorderUnifiedTabs: (groupId, tabIds) => {
    set((state) => {
      for (const [worktreeId, groups] of Object.entries(state.groupsByWorktree)) {
        const group = groups.find((candidate) => candidate.id === groupId)
        if (!group) {
          continue
        }
        const orderMap = new Map(tabIds.map((id, index) => [id, index]))
        return {
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [worktreeId]: updateGroup(groups, { ...group, tabOrder: tabIds })
          },
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [worktreeId]: (state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => {
              const sortOrder = orderMap.get(tab.id)
              return sortOrder === undefined ? tab : { ...tab, sortOrder }
            })
          }
        }
      }
      return {}
    })
  },

  setTabLabel: (tabId, label) =>
    set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { label }) ?? {}),
  setTabCustomLabel: (tabId, label) =>
    set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { customLabel: label }) ?? {}),
  setUnifiedTabColor: (tabId, color) =>
    set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { color }) ?? {}),
  pinTab: (tabId) =>
    set(
      (state) =>
        patchTab(state.unifiedTabsByWorktree, tabId, { isPinned: true, isPreview: false }) ?? {}
    ),
  unpinTab: (tabId) =>
    set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { isPinned: false }) ?? {}),

  closeOtherTabs: (tabId) => {
    const state = get()
    const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
    if (!found) {
      return []
    }
    const { tab, worktreeId } = found
    const group = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
    if (!group) {
      return []
    }
    const closedIds = (state.unifiedTabsByWorktree[worktreeId] ?? [])
      .filter((item) => item.groupId === group.id && item.id !== tabId && !item.isPinned)
      .map((item) => item.id)
    for (const id of closedIds) {
      get().closeUnifiedTab(id)
    }
    return closedIds
  },

  closeTabsToRight: (tabId) => {
    const state = get()
    const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
    if (!found) {
      return []
    }
    const { tab, worktreeId } = found
    const group = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
    if (!group) {
      return []
    }
    const index = group.tabOrder.indexOf(tabId)
    if (index === -1) {
      return []
    }
    const closableIds = group.tabOrder
      .slice(index + 1)
      .filter(
        (id) =>
          !(state.unifiedTabsByWorktree[worktreeId] ?? []).find((tab) => tab.id === id)?.isPinned
      )
    for (const id of closableIds) {
      get().closeUnifiedTab(id)
    }
    return closableIds
  },

  ensureWorktreeRootGroup: (worktreeId) => {
    const existingGroups = get().groupsByWorktree[worktreeId] ?? []
    if (existingGroups.length > 0) {
      const existingActiveGroupId = get().activeGroupIdByWorktree[worktreeId]
      return existingActiveGroupId ?? existingGroups[0].id
    }

    const groupId = globalThis.crypto.randomUUID()
    set((state) => ({
      // Why: a freshly selected worktree can legitimately have zero tabs, but
      // split-tab affordances still need a canonical root group so the titlebar
      // tab strip remains visible and can open/split the first tab.
      groupsByWorktree: {
        ...state.groupsByWorktree,
        [worktreeId]: [{ id: groupId, worktreeId, activeTabId: null, tabOrder: [] }]
      },
      layoutByWorktree: {
        ...state.layoutByWorktree,
        [worktreeId]: { type: 'leaf', groupId }
      },
      activeGroupIdByWorktree: {
        ...state.activeGroupIdByWorktree,
        [worktreeId]: groupId
      }
    }))
    return groupId
  },

  focusGroup: (worktreeId, groupId) =>
    set((state) => ({
      activeGroupIdByWorktree: { ...state.activeGroupIdByWorktree, [worktreeId]: groupId }
    })),

  closeEmptyGroup: (worktreeId, groupId) => {
    const state = get()
    const group = (state.groupsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.id === groupId
    )
    if (!group || group.tabOrder.length > 0) {
      return false
    }
    // Why: removing an empty split neighbor still rewrites the layout tree and
    // remounts the surviving terminal pane. Capture buffers first so visible
    // terminal state survives the remount.
    captureAllTerminalBuffers()
    set((current) => {
      const remainingGroups = (current.groupsByWorktree[worktreeId] ?? []).filter(
        (candidate) => candidate.id !== groupId
      )
      const nextCollapsedState = collapseGroupLayout(
        current.layoutByWorktree,
        current.activeGroupIdByWorktree,
        worktreeId,
        groupId,
        remainingGroups[0]?.id ?? null
      )
      return {
        groupsByWorktree: {
          ...current.groupsByWorktree,
          [worktreeId]: remainingGroups
        },
        layoutByWorktree: nextCollapsedState.layoutByWorktree,
        activeGroupIdByWorktree: nextCollapsedState.activeGroupIdByWorktree
      }
    })
    return true
  },

  createEmptySplitGroup: (worktreeId, sourceGroupId, direction) => {
    const groups = get().groupsByWorktree[worktreeId] ?? []
    if (!groups.some((group) => group.id === sourceGroupId)) {
      return null
    }
    // Why: creating a neighboring group rewrites the layout from leaf -> split,
    // which remounts the existing terminal pane. Capture buffers before the
    // mutation so partially typed commands are present in the next mount's
    // restored xterm viewport.
    captureAllTerminalBuffers()
    const newGroupId = globalThis.crypto.randomUUID()
    // Why: v1 split groups only create empty neighboring groups. Cloning the
    // current tab here would duplicate terminal/browser runtime identities or
    // implicitly create another editor instance, which is exactly the cross-slice
    // ownership bug this layout-only split flow is meant to avoid.
    const splitDirection = direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical'
    const position = direction === 'left' || direction === 'up' ? 'first' : 'second'
    set((current) => {
      const layout = current.layoutByWorktree[worktreeId] ?? {
        type: 'leaf',
        groupId: sourceGroupId
      }
      return {
        groupsByWorktree: {
          ...current.groupsByWorktree,
          [worktreeId]: [
            ...(current.groupsByWorktree[worktreeId] ?? []),
            { id: newGroupId, worktreeId, activeTabId: null, tabOrder: [] }
          ]
        },
        layoutByWorktree: {
          ...current.layoutByWorktree,
          [worktreeId]: replaceLeaf(
            layout,
            sourceGroupId,
            buildSplitNode(sourceGroupId, newGroupId, splitDirection, position)
          )
        },
        activeGroupIdByWorktree: {
          ...current.activeGroupIdByWorktree,
          [worktreeId]: newGroupId
        }
      }
    })
    return newGroupId
  },

  hydrateTabsSession: (session) => {
    const validWorktreeIds = new Set(
      Object.values(get().worktreesByRepo)
        .flat()
        .map((worktree) => worktree.id)
    )
    set(hydrateTabsState(session, validWorktreeIds))
  }
})
