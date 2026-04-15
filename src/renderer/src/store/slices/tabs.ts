/* eslint-disable max-lines -- Why: split-tab group state has to update layout,
 * per-group focus, and tab membership atomically. Keeping those transitions in
 * one slice avoids split-brain behavior between the unified tab model and the
 * legacy terminal/editor/browser content slices. */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  Tab,
  TabContentType,
  TabGroup,
  TabGroupLayoutNode,
  WorkspaceSessionState,
  WorkspaceVisibleTabType
} from '../../../../shared/types'
import {
  ensureGroup,
  findGroupAndWorktree,
  findGroupForTab,
  findTabAndWorktree,
  findTabByEntityInGroup,
  patchTab,
  pickNeighbor,
  updateGroup
} from './tabs-helpers'
import { buildHydratedTabState } from './tabs-hydration'
import { buildOrphanTerminalCleanupPatch, getOrphanTerminalIds } from './terminal-orphan-helpers'

export type TabSplitDirection = 'left' | 'right' | 'up' | 'down'

export type TabsSlice = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
  createUnifiedTab: (
    worktreeId: string,
    contentType: TabContentType,
    init?: Partial<
      Pick<
        Tab,
        'id' | 'entityId' | 'label' | 'customLabel' | 'color' | 'isPreview' | 'isPinned'
      > & {
        targetGroupId: string
      }
    >
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
  moveUnifiedTabToGroup: (
    tabId: string,
    targetGroupId: string,
    opts?: { index?: number; activate?: boolean }
  ) => boolean
  copyUnifiedTabToGroup: (
    tabId: string,
    targetGroupId: string,
    init?: Partial<Pick<Tab, 'id' | 'entityId' | 'label' | 'customLabel' | 'color' | 'isPinned'>>
  ) => Tab | null
  mergeGroupIntoSibling: (worktreeId: string, groupId: string) => string | null
  setTabGroupSplitRatio: (worktreeId: string, nodePath: string, ratio: number) => void
  reconcileWorktreeTabModel: (worktreeId: string) => {
    renderableTabCount: number
    activeRenderableTabId: string | null
  }
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
    second: position === 'second' ? newLeaf : existingLeaf,
    ratio: 0.5
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

function updateSplitRatio(
  root: TabGroupLayoutNode,
  path: string[],
  ratio: number
): TabGroupLayoutNode {
  if (path.length === 0) {
    return root.type === 'split' ? { ...root, ratio } : root
  }
  if (root.type !== 'split') {
    return root
  }
  const [segment, ...rest] = path
  if (segment === 'first') {
    return { ...root, first: updateSplitRatio(root.first, rest, ratio) }
  }
  if (segment === 'second') {
    return { ...root, second: updateSplitRatio(root.second, rest, ratio) }
  }
  return root
}

function findFirstLeaf(root: TabGroupLayoutNode): string {
  return root.type === 'leaf' ? root.groupId : findFirstLeaf(root.first)
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

function toVisibleTabType(contentType: TabContentType): WorkspaceVisibleTabType {
  return contentType === 'browser' ? 'browser' : contentType === 'terminal' ? 'terminal' : 'editor'
}

function deriveActiveSurfaceForWorktree(
  state: Pick<
    AppState,
    | 'activeBrowserTabIdByWorktree'
    | 'activeFileIdByWorktree'
    | 'activeGroupIdByWorktree'
    | 'activeTabIdByWorktree'
    | 'browserTabsByWorktree'
    | 'groupsByWorktree'
    | 'layoutByWorktree'
    | 'openFiles'
    | 'tabsByWorktree'
    | 'unifiedTabsByWorktree'
  >,
  worktreeId: string,
  preferredGroupId?: string | null
): {
  activeBrowserTabId: string | null
  activeFileId: string | null
  activeTabId: string | null
  activeTabType: WorkspaceVisibleTabType
} {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const activeGroupId = preferredGroupId ?? state.activeGroupIdByWorktree[worktreeId] ?? null
  const activeGroup =
    (activeGroupId ? groups.find((group) => group.id === activeGroupId) : null) ?? groups[0] ?? null
  const activeUnifiedTab =
    activeGroup?.activeTabId != null
      ? ((state.unifiedTabsByWorktree[worktreeId] ?? []).find(
          (tab) => tab.id === activeGroup.activeTabId && tab.groupId === activeGroup.id
        ) ?? null)
      : null
  const restoredFileId = state.activeFileIdByWorktree[worktreeId] ?? null
  const restoredBrowserTabId = state.activeBrowserTabIdByWorktree[worktreeId] ?? null
  const restoredTerminalTabId = state.activeTabIdByWorktree[worktreeId] ?? null
  const browserTabs = state.browserTabsByWorktree[worktreeId] ?? []
  const terminalTabs = state.tabsByWorktree[worktreeId] ?? []
  const fileStillOpen = restoredFileId
    ? state.openFiles.some((file) => file.id === restoredFileId && file.worktreeId === worktreeId)
    : false
  const browserTabStillOpen = restoredBrowserTabId
    ? browserTabs.some((tab) => tab.id === restoredBrowserTabId)
    : false
  const terminalTabStillExists = restoredTerminalTabId
    ? terminalTabs.some((tab) => tab.id === restoredTerminalTabId)
    : false
  const hasGroupOwnedSurface = groups.length > 0 || Boolean(state.layoutByWorktree[worktreeId])

  let activeFileId: string | null
  let activeBrowserTabId: string | null
  let activeTabType: WorkspaceVisibleTabType

  if (activeUnifiedTab) {
    activeFileId =
      activeUnifiedTab.contentType === 'editor' ||
      activeUnifiedTab.contentType === 'diff' ||
      activeUnifiedTab.contentType === 'conflict-review'
        ? activeUnifiedTab.entityId
        : fileStillOpen
          ? restoredFileId
          : null
    activeBrowserTabId =
      activeUnifiedTab.contentType === 'browser'
        ? activeUnifiedTab.entityId
        : browserTabStillOpen
          ? restoredBrowserTabId
          : (browserTabs[0]?.id ?? null)
    activeTabType = toVisibleTabType(activeUnifiedTab.contentType)
  } else if (hasGroupOwnedSurface) {
    activeFileId = fileStillOpen ? restoredFileId : null
    activeBrowserTabId = browserTabStillOpen ? restoredBrowserTabId : (browserTabs[0]?.id ?? null)
    // Why: when the user focuses an empty split, global shortcuts should
    // target that group's default terminal area instead of the previously
    // active browser/editor in another group.
    activeTabType = 'terminal'
  } else if (browserTabStillOpen) {
    activeFileId = fileStillOpen ? restoredFileId : null
    activeBrowserTabId = restoredBrowserTabId
    activeTabType = 'browser'
  } else if (fileStillOpen) {
    activeFileId = restoredFileId
    activeBrowserTabId = browserTabs[0]?.id ?? null
    activeTabType = 'editor'
  } else {
    const fallbackFile = state.openFiles.find((file) => file.worktreeId === worktreeId) ?? null
    const fallbackBrowserTab = browserTabs[0] ?? null
    activeFileId = fallbackFile?.id ?? null
    activeBrowserTabId = fallbackBrowserTab?.id ?? null
    activeTabType = fallbackFile ? 'editor' : fallbackBrowserTab ? 'browser' : 'terminal'
  }

  return {
    activeBrowserTabId,
    activeFileId,
    activeTabId:
      activeUnifiedTab?.contentType === 'terminal'
        ? activeUnifiedTab.entityId
        : terminalTabStillExists
          ? restoredTerminalTabId
          : (terminalTabs[0]?.id ?? null),
    activeTabType
  }
}

function buildActiveSurfacePatch(
  state: Pick<
    AppState,
    | 'activeBrowserTabIdByWorktree'
    | 'activeFileIdByWorktree'
    | 'activeGroupIdByWorktree'
    | 'activeTabIdByWorktree'
    | 'activeTabTypeByWorktree'
    | 'browserTabsByWorktree'
    | 'groupsByWorktree'
    | 'layoutByWorktree'
    | 'openFiles'
    | 'tabsByWorktree'
    | 'unifiedTabsByWorktree'
  >,
  worktreeId: string,
  preferredGroupId?: string | null
): Pick<
  AppState,
  | 'activeBrowserTabId'
  | 'activeBrowserTabIdByWorktree'
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
> {
  const derived = deriveActiveSurfaceForWorktree(state, worktreeId, preferredGroupId)
  return {
    activeBrowserTabId: derived.activeBrowserTabId,
    activeBrowserTabIdByWorktree: {
      ...state.activeBrowserTabIdByWorktree,
      [worktreeId]: derived.activeBrowserTabId
    },
    activeFileId: derived.activeFileId,
    activeFileIdByWorktree: {
      ...state.activeFileIdByWorktree,
      [worktreeId]: derived.activeFileId
    },
    activeTabId: derived.activeTabId,
    activeTabIdByWorktree: {
      ...state.activeTabIdByWorktree,
      [worktreeId]: derived.activeTabId
    },
    activeTabType: derived.activeTabType,
    activeTabTypeByWorktree: {
      ...state.activeTabTypeByWorktree,
      [worktreeId]: derived.activeTabType
    }
  }
}

export const createTabsSlice: StateCreator<AppState, [], [], TabsSlice> = (set, get) => ({
  unifiedTabsByWorktree: {},
  groupsByWorktree: {},
  activeGroupIdByWorktree: {},
  layoutByWorktree: {},

  createUnifiedTab: (worktreeId, contentType, init) => {
    const id = init?.id ?? globalThis.crypto.randomUUID()
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
      let nextOrder = [...group.tabOrder]
      if (init?.isPreview) {
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
        entityId: init?.entityId ?? id,
        groupId: group.id,
        worktreeId,
        contentType,
        label:
          init?.label ?? (contentType === 'terminal' ? `Terminal ${existingTabs.length + 1}` : id),
        customLabel: init?.customLabel ?? null,
        color: init?.color ?? null,
        sortOrder: nextOrder.length,
        createdAt: Date.now(),
        isPreview: init?.isPreview,
        isPinned: init?.isPinned
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

    set((current) => {
      const nextTabs = (current.unifiedTabsByWorktree[worktreeId] ?? []).filter(
        (item) => item.id !== tabId
      )
      let nextGroups = (current.groupsByWorktree[worktreeId] ?? []).map((candidate) =>
        candidate.id === group.id
          ? { ...candidate, activeTabId: nextActiveTabId, tabOrder: remainingOrder }
          : candidate
      )
      let nextLayoutByWorktree = current.layoutByWorktree
      let nextActiveGroupIdByWorktree = current.activeGroupIdByWorktree
      if (wasLastTab && current.layoutByWorktree[worktreeId] && nextGroups.length > 1) {
        nextGroups = nextGroups.filter((candidate) => candidate.id !== group.id)
        const collapsedState = collapseGroupLayout(
          current.layoutByWorktree,
          current.activeGroupIdByWorktree,
          worktreeId,
          group.id,
          nextGroups[0]?.id ?? null
        )
        nextLayoutByWorktree = collapsedState.layoutByWorktree
        nextActiveGroupIdByWorktree = collapsedState.activeGroupIdByWorktree
      }
      const shouldDeactivateWorktree =
        current.activeWorktreeId === worktreeId &&
        nextTabs.length === 0 &&
        (current.tabsByWorktree[worktreeId] ?? []).length === 0 &&
        (current.browserTabsByWorktree[worktreeId] ?? []).length === 0 &&
        !current.openFiles.some((file) => file.worktreeId === worktreeId)
      return {
        unifiedTabsByWorktree: { ...current.unifiedTabsByWorktree, [worktreeId]: nextTabs },
        groupsByWorktree: {
          ...current.groupsByWorktree,
          [worktreeId]: nextGroups
        },
        layoutByWorktree: nextLayoutByWorktree,
        activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
        // Why: the split-group model can legally derive "terminal with no
        // active tab" after the final unified tab closes. That leaves the
        // worktree selected but render-empty, so the workspace shows a blank
        // pane instead of Orca's landing screen. When that happens, write the
        // landing-state fallback directly instead of recomputing active-surface
        // fields from a worktree that is no longer active.
        ...(shouldDeactivateWorktree
          ? {
              activeWorktreeId: null,
              activeTabId: null,
              activeBrowserTabId: null,
              activeFileId: null,
              activeTabType: 'terminal' as const,
              activeTabIdByWorktree: {
                ...current.activeTabIdByWorktree,
                [worktreeId]: null
              },
              activeBrowserTabIdByWorktree: {
                ...current.activeBrowserTabIdByWorktree,
                [worktreeId]: null
              },
              activeFileIdByWorktree: {
                ...current.activeFileIdByWorktree,
                [worktreeId]: null
              },
              activeTabTypeByWorktree: {
                ...current.activeTabTypeByWorktree,
                [worktreeId]: 'terminal'
              }
            }
          : {}),
        ...(!shouldDeactivateWorktree && current.activeWorktreeId === worktreeId
          ? buildActiveSurfacePatch(
              {
                ...current,
                unifiedTabsByWorktree: {
                  ...current.unifiedTabsByWorktree,
                  [worktreeId]: nextTabs
                },
                groupsByWorktree: {
                  ...current.groupsByWorktree,
                  [worktreeId]: nextGroups
                },
                layoutByWorktree: nextLayoutByWorktree,
                activeGroupIdByWorktree: nextActiveGroupIdByWorktree
              },
              worktreeId,
              nextActiveGroupIdByWorktree[worktreeId] ?? null
            )
          : {})
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
          !(state.unifiedTabsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === id)
            ?.isPinned
      )
    for (const id of closableIds) {
      get().closeUnifiedTab(id)
    }
    return closableIds
  },

  ensureWorktreeRootGroup: (worktreeId) => {
    const existingGroups = get().groupsByWorktree[worktreeId] ?? []
    if (existingGroups.length > 0) {
      return get().activeGroupIdByWorktree[worktreeId] ?? existingGroups[0].id
    }

    const groupId = globalThis.crypto.randomUUID()
    set((state) => ({
      // Why: a freshly selected worktree can legitimately have zero tabs, but
      // split-group affordances still need a canonical root group so new tabs
      // and splits land in a deterministic place like VS Code's editor area.
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
    set((state) => {
      const nextActiveGroupIdByWorktree = {
        ...state.activeGroupIdByWorktree,
        [worktreeId]: groupId
      }
      if (state.activeWorktreeId !== worktreeId) {
        return {
          activeGroupIdByWorktree: nextActiveGroupIdByWorktree
        }
      }
      return {
        activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
        ...buildActiveSurfacePatch(
          {
            ...state,
            activeGroupIdByWorktree: nextActiveGroupIdByWorktree
          },
          worktreeId,
          groupId
        )
      }
    }),

  closeEmptyGroup: (worktreeId, groupId) => {
    const state = get()
    const group = (state.groupsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.id === groupId
    )
    if (!group || group.tabOrder.length > 0) {
      return false
    }
    set((current) => {
      const remainingGroups = (current.groupsByWorktree[worktreeId] ?? []).filter(
        (candidate) => candidate.id !== groupId
      )
      const collapsedState = collapseGroupLayout(
        current.layoutByWorktree,
        current.activeGroupIdByWorktree,
        worktreeId,
        groupId,
        remainingGroups[0]?.id ?? null
      )
      return {
        groupsByWorktree: { ...current.groupsByWorktree, [worktreeId]: remainingGroups },
        layoutByWorktree: collapsedState.layoutByWorktree,
        activeGroupIdByWorktree: collapsedState.activeGroupIdByWorktree,
        ...(current.activeWorktreeId === worktreeId
          ? buildActiveSurfacePatch(
              {
                ...current,
                groupsByWorktree: {
                  ...current.groupsByWorktree,
                  [worktreeId]: remainingGroups
                },
                layoutByWorktree: collapsedState.layoutByWorktree,
                activeGroupIdByWorktree: collapsedState.activeGroupIdByWorktree
              },
              worktreeId,
              collapsedState.activeGroupIdByWorktree[worktreeId] ?? null
            )
          : {})
      }
    })
    return true
  },

  createEmptySplitGroup: (worktreeId, sourceGroupId, direction) => {
    const newGroupId = globalThis.crypto.randomUUID()
    const newGroup: TabGroup = {
      id: newGroupId,
      worktreeId,
      activeTabId: null,
      tabOrder: []
    }
    set((state) => {
      const existing = state.groupsByWorktree[worktreeId] ?? []
      const currentLayout =
        state.layoutByWorktree[worktreeId] ?? ({ type: 'leaf', groupId: sourceGroupId } as const)
      const replacement = buildSplitNode(
        sourceGroupId,
        newGroupId,
        direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
        direction === 'left' || direction === 'up' ? 'first' : 'second'
      )
      return {
        groupsByWorktree: { ...state.groupsByWorktree, [worktreeId]: [...existing, newGroup] },
        layoutByWorktree: {
          ...state.layoutByWorktree,
          [worktreeId]: replaceLeaf(currentLayout, sourceGroupId, replacement)
        },
        activeGroupIdByWorktree: { ...state.activeGroupIdByWorktree, [worktreeId]: newGroupId }
      }
    })
    return newGroupId
  },

  moveUnifiedTabToGroup: (tabId, targetGroupId, opts) => {
    let moved = false
    set((state) => {
      const foundTab = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      const foundTarget = findGroupAndWorktree(state.groupsByWorktree, targetGroupId)
      if (!foundTab || !foundTarget || foundTab.worktreeId !== foundTarget.worktreeId) {
        return {}
      }
      const { tab, worktreeId } = foundTab
      if (tab.groupId === targetGroupId) {
        return {}
      }
      const sourceGroup = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
      const targetGroup = foundTarget.group
      if (!sourceGroup) {
        return {}
      }
      moved = true

      const sourceOrder = sourceGroup.tabOrder.filter((id) => id !== tabId)
      const targetOrder = [...targetGroup.tabOrder]
      const targetIndex = Math.max(
        0,
        Math.min(opts?.index ?? targetOrder.length, targetOrder.length)
      )
      targetOrder.splice(targetIndex, 0, tabId)
      const nextActiveGroupIdByWorktree = {
        ...state.activeGroupIdByWorktree,
        [worktreeId]: opts?.activate ? targetGroupId : state.activeGroupIdByWorktree[worktreeId]
      }
      const nextGroups = (state.groupsByWorktree[worktreeId] ?? []).map((group) => {
        if (group.id === sourceGroup.id) {
          return {
            ...group,
            activeTabId:
              group.activeTabId === tabId ? pickNeighbor(group.tabOrder, tabId) : group.activeTabId,
            tabOrder: sourceOrder
          }
        }
        if (group.id === targetGroupId) {
          return {
            ...group,
            activeTabId: opts?.activate ? tabId : group.activeTabId,
            tabOrder: targetOrder
          }
        }
        return group
      })
      return {
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [worktreeId]: (state.unifiedTabsByWorktree[worktreeId] ?? []).map((candidate) =>
            candidate.id === tabId ? { ...candidate, groupId: targetGroupId } : candidate
          )
        },
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [worktreeId]: nextGroups
        },
        activeGroupIdByWorktree: nextActiveGroupIdByWorktree
      }
    })
    return moved
  },

  copyUnifiedTabToGroup: (tabId, targetGroupId, init) => {
    const foundTab = findTabAndWorktree(get().unifiedTabsByWorktree, tabId)
    const foundTarget = findGroupAndWorktree(get().groupsByWorktree, targetGroupId)
    if (!foundTab || !foundTarget || foundTab.worktreeId !== foundTarget.worktreeId) {
      return null
    }
    const { tab, worktreeId } = foundTab
    return get().createUnifiedTab(worktreeId, tab.contentType, {
      entityId: init?.entityId ?? tab.entityId,
      label: init?.label ?? tab.label,
      customLabel: init?.customLabel ?? tab.customLabel,
      color: init?.color ?? tab.color,
      isPinned: init?.isPinned ?? tab.isPinned,
      id: init?.id,
      targetGroupId
    })
  },

  mergeGroupIntoSibling: (worktreeId, groupId) => {
    const state = get()
    const groups = state.groupsByWorktree[worktreeId] ?? []
    const sourceGroup = groups.find((candidate) => candidate.id === groupId)
    const layout = state.layoutByWorktree[worktreeId]
    if (!sourceGroup || !layout || groups.length <= 1) {
      return null
    }
    const targetGroupId = findSiblingGroupId(layout, groupId)
    if (!targetGroupId) {
      return null
    }

    const orderedSourceTabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
      (tab) => tab.groupId === groupId
    )
    for (const tabId of sourceGroup.tabOrder) {
      const item = orderedSourceTabs.find((tab) => tab.id === tabId)
      if (!item) {
        continue
      }
      get().moveUnifiedTabToGroup(item.id, targetGroupId)
    }
    get().closeEmptyGroup(worktreeId, groupId)
    return targetGroupId
  },

  setTabGroupSplitRatio: (worktreeId, nodePath, ratio) =>
    set((state) => {
      const currentLayout = state.layoutByWorktree[worktreeId]
      if (!currentLayout) {
        return {}
      }
      return {
        layoutByWorktree: {
          ...state.layoutByWorktree,
          // Why: split sizing is part of the tab-group model, not transient UI
          // state. Persisting ratios here keeps restores and multi-step group
          // operations in sync with what the user actually resized.
          [worktreeId]: updateSplitRatio(
            currentLayout,
            nodePath.length > 0 ? nodePath.split('.') : [],
            ratio
          )
        }
      }
    }),

  reconcileWorktreeTabModel: (worktreeId) => {
    const state = get()
    const unifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const groups = state.groupsByWorktree[worktreeId] ?? []
    const runtimeTerminalTabs = state.tabsByWorktree[worktreeId] ?? []
    const unifiedTerminalEntityIds = new Set(
      unifiedTabs.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
    )
    const legacyRuntimeTerminalTabs = runtimeTerminalTabs.filter((tab) => {
      if (unifiedTerminalEntityIds.has(tab.id)) {
        return false
      }
      const livePtyIds = state.ptyIdsByTabId[tab.id] ?? []
      return livePtyIds.length > 0 || tab.ptyId != null
    })
    const orphanTerminalIds = getOrphanTerminalIds(state, worktreeId)
    const ensuredGroupState =
      legacyRuntimeTerminalTabs.length > 0
        ? ensureGroup(
            state.groupsByWorktree,
            state.activeGroupIdByWorktree,
            worktreeId,
            state.activeGroupIdByWorktree[worktreeId]
          )
        : null
    const reconciliationGroup = ensuredGroupState?.group ?? groups[0] ?? null
    const restoredLegacyTabs =
      reconciliationGroup == null
        ? []
        : legacyRuntimeTerminalTabs
            .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
            .map((tab) => ({
              id: tab.id,
              entityId: tab.id,
              groupId: reconciliationGroup.id,
              worktreeId,
              contentType: 'terminal' as const,
              label: tab.title,
              customLabel: tab.customTitle,
              color: tab.color,
              sortOrder: tab.sortOrder,
              createdAt: tab.createdAt
            }))
    const reconciledUnifiedTabs =
      restoredLegacyTabs.length > 0 ? [...unifiedTabs, ...restoredLegacyTabs] : unifiedTabs
    const reconciledGroups =
      restoredLegacyTabs.length > 0 && reconciliationGroup
        ? updateGroup(ensuredGroupState!.groupsByWorktree[worktreeId] ?? [], {
            ...reconciliationGroup,
            // Why: legacy terminal tabs can still exist in the runtime slice
            // after split groups became the source of truth. Restoring them
            // into the active/root group keeps existing live PTYs reachable
            // instead of making activation spawn a duplicate "Terminal 2".
            activeTabId: reconciliationGroup.activeTabId ?? restoredLegacyTabs[0]?.id ?? null,
            tabOrder: [
              ...reconciliationGroup.tabOrder,
              ...restoredLegacyTabs
                .map((tab) => tab.id)
                .filter((tabId) => !reconciliationGroup.tabOrder.includes(tabId))
            ]
          })
        : groups
    const liveTerminalIds = new Set(
      runtimeTerminalTabs.filter((tab) => !orphanTerminalIds.has(tab.id)).map((tab) => tab.id)
    )
    const liveEditorIds = new Set(
      state.openFiles.filter((file) => file.worktreeId === worktreeId).map((file) => file.id)
    )
    const liveBrowserIds = new Set(
      (state.browserTabsByWorktree[worktreeId] ?? []).map((browserTab) => browserTab.id)
    )

    const isRenderableTab = (tab: Tab): boolean => {
      if (tab.contentType === 'terminal') {
        return liveTerminalIds.has(tab.entityId)
      }
      if (tab.contentType === 'browser') {
        return liveBrowserIds.has(tab.entityId)
      }
      return liveEditorIds.has(tab.entityId)
    }

    const validTabs = reconciledUnifiedTabs.filter(isRenderableTab)
    const validTabIds = new Set(validTabs.map((tab) => tab.id))

    const nextGroups = reconciledGroups.map((group) => {
      const tabOrder = group.tabOrder.filter((tabId) => validTabIds.has(tabId))
      const activeTabId =
        group.activeTabId && validTabIds.has(group.activeTabId)
          ? group.activeTabId
          : (tabOrder[0] ?? null)
      const tabOrderUnchanged =
        tabOrder.length === group.tabOrder.length &&
        tabOrder.every((tabId, index) => tabId === group.tabOrder[index])
      return tabOrderUnchanged && activeTabId === group.activeTabId
        ? group
        : { ...group, tabOrder, activeTabId }
    })

    const currentActiveGroupId =
      state.activeGroupIdByWorktree[worktreeId] ??
      ensuredGroupState?.activeGroupIdByWorktree[worktreeId]
    const activeGroupStillExists = nextGroups.some((group) => group.id === currentActiveGroupId)
    const nextActiveGroupId = activeGroupStillExists
      ? currentActiveGroupId
      : (nextGroups.find((group) => group.activeTabId !== null)?.id ??
        nextGroups[0]?.id ??
        currentActiveGroupId)

    const groupsChanged =
      nextGroups.length !== groups.length ||
      nextGroups.some((group, index) => group !== groups[index])
    const tabsChanged = validTabs.length !== unifiedTabs.length || restoredLegacyTabs.length > 0
    const activeGroupChanged = nextActiveGroupId !== currentActiveGroupId

    const nextLayout =
      restoredLegacyTabs.length > 0 && reconciliationGroup
        ? (state.layoutByWorktree[worktreeId] ?? { type: 'leaf', groupId: reconciliationGroup.id })
        : state.layoutByWorktree[worktreeId]

    if (tabsChanged || groupsChanged || activeGroupChanged || orphanTerminalIds.size > 0) {
      set((current) => ({
        unifiedTabsByWorktree: { ...current.unifiedTabsByWorktree, [worktreeId]: validTabs },
        groupsByWorktree: { ...current.groupsByWorktree, [worktreeId]: nextGroups },
        activeGroupIdByWorktree: {
          ...current.activeGroupIdByWorktree,
          [worktreeId]: nextActiveGroupId
        },
        ...(restoredLegacyTabs.length > 0
          ? {
              layoutByWorktree: {
                ...current.layoutByWorktree,
                // Why: a restored live runtime terminal needs a concrete leaf
                // in the split-group model before activation runs again.
                // Without this, the worktree still looks render-empty and the
                // activation fallback spawns a duplicate "Terminal 2".
                [worktreeId]: nextLayout!
              }
            }
          : {}),
        ...(orphanTerminalIds.size > 0
          ? buildOrphanTerminalCleanupPatch(current, worktreeId, orphanTerminalIds)
          : {})
      }))
    }

    const activeRenderableTabId =
      nextGroups.find((group) => group.id === nextActiveGroupId)?.activeTabId ??
      nextGroups.find((group) => group.activeTabId !== null)?.activeTabId ??
      null

    return {
      renderableTabCount: validTabs.length,
      activeRenderableTabId
    }
  },

  hydrateTabsSession: (session) => {
    const state = get()
    const validWorktreeIds = new Set(
      Object.values(state.worktreesByRepo)
        .flat()
        .map((w) => w.id)
    )
    set(buildHydratedTabState(session, validWorktreeIds))
  }
})
