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
  TerminalTab,
  TuiAgent,
  WorkspaceSessionState,
  WorkspaceVisibleTabType
} from '../../../../shared/types'
import { emitNativeChatToggled } from '@/lib/native-chat-telemetry'
import {
  dedupeTabOrder,
  ensureGroup,
  findGroupAndWorktree,
  findGroupForTab,
  findTabAndWorktree,
  findTabByEntityInGroup,
  patchTab,
  pickNextActiveTab,
  pushRecentTabId,
  sanitizeRecentTabIds,
  updateGroup
} from './tab-group-state'
import { isPaneColumnSplitDropNoOp } from './pane-column-split-drop-no-op'
import { buildHydratedTabState, pruneTabGroupLayoutForGroups } from './tabs-hydration'
import { buildOrphanTerminalCleanupPatch, getOrphanTerminalIds } from './terminal-orphan-helpers'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  addAdditionalValidWorkspaceKeys,
  type WorkspaceSessionHydrationOptions
} from '@/lib/workspace-session-hydration-keys'

export type TabSplitDirection = 'left' | 'right' | 'up' | 'down'

export type TabsSlice = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  // Why: signals the matching tab's inline title editor to open. A global
  // keyboard shortcut (tab.rename) sets this; the tab clears it on consume.
  renamingTabId: string | null
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
  createUnifiedTab: (
    worktreeId: string,
    contentType: TabContentType,
    init?: Partial<
      Pick<
        Tab,
        | 'id'
        | 'entityId'
        | 'label'
        | 'generatedLabel'
        | 'quickCommandLabel'
        | 'customLabel'
        | 'color'
        | 'isPreview'
        | 'isPinned'
      > & {
        targetGroupId: string
        activate: boolean
        recordInteraction: boolean
      }
    >
  ) => Tab
  createUnifiedTabInSplit: (
    worktreeId: string,
    contentType: TabContentType,
    target: {
      sourceGroupId: string
      splitDirection: TabSplitDirection
    },
    init?: Partial<
      Pick<
        Tab,
        | 'id'
        | 'entityId'
        | 'label'
        | 'generatedLabel'
        | 'quickCommandLabel'
        | 'customLabel'
        | 'color'
        | 'isPreview'
        | 'isPinned'
      > & {
        activate: boolean
        recordInteraction: boolean
      }
    >
  ) => Tab | null
  getTab: (tabId: string) => Tab | null
  getActiveTab: (worktreeId: string) => Tab | null
  findTabForEntityInGroup: (
    worktreeId: string,
    groupId: string,
    entityId: string,
    contentType?: TabContentType
  ) => Tab | null
  activateTab: (tabId: string, opts?: { preservePreview?: boolean }) => void
  closeUnifiedTab: (
    tabId: string,
    opts?: { recordInteraction?: boolean }
  ) => { closedTabId: string; wasLastTab: boolean; worktreeId: string } | null
  reorderUnifiedTabs: (
    groupId: string,
    tabIds: string[],
    opts?: { recordInteraction?: boolean }
  ) => void
  setTabLabel: (tabId: string, label: string) => void
  /** Set a tab's view mode (terminal vs native chat). Patches only that tab. */
  setTabViewMode: (tabId: string, mode: 'terminal' | 'chat') => void
  /** Flip a tab between the terminal and native chat renderings. The live
   *  TerminalPane stays mounted — this only changes which surface is shown. */
  toggleTabViewMode: (tabId: string) => void
  setTabCustomLabel: (
    tabId: string,
    label: string | null,
    opts?: { recordInteraction?: boolean }
  ) => void
  setUnifiedTabColor: (tabId: string, color: string | null) => void
  setRenamingTabId: (tabId: string | null) => void
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
    opts?: { index?: number; activate?: boolean; recordInteraction?: boolean }
  ) => boolean
  dropUnifiedTab: (
    tabId: string,
    target: {
      groupId: string
      index?: number
      splitDirection?: TabSplitDirection
    }
  ) => boolean
  copyUnifiedTabToGroup: (
    tabId: string,
    targetGroupId: string,
    init?: Partial<
      Pick<
        Tab,
        | 'id'
        | 'entityId'
        | 'label'
        | 'generatedLabel'
        | 'quickCommandLabel'
        | 'customLabel'
        | 'color'
        | 'isPinned'
      >
    >
  ) => Tab | null
  mergeGroupIntoSibling: (worktreeId: string, groupId: string) => string | null
  setTabGroupSplitRatio: (worktreeId: string, nodePath: string, ratio: number) => void
  reconcileWorktreeTabModel: (worktreeId: string) => {
    renderableTabCount: number
    activeRenderableTabId: string | null
  }
  hydrateTabsSession: (
    session: WorkspaceSessionState,
    options?: WorkspaceSessionHydrationOptions
  ) => void
}

// Why: keep the TerminalTab (tabsByWorktree) pin in sync with the unified-tab
// pin so reconcile's `existing.isPinned` fallback stays authoritative locally.
// Returns an empty patch when the tab isn't a persisted TerminalTab.
function patchTerminalTabPinned(
  tabsByWorktree: Record<string, TerminalTab[]>,
  worktreeId: string,
  tabId: string,
  isPinned: boolean
): Partial<Pick<AppState, 'tabsByWorktree'>> {
  const tabs = tabsByWorktree[worktreeId]
  if (!tabs?.some((tab) => tab.id === tabId)) {
    return {}
  }
  return {
    tabsByWorktree: {
      ...tabsByWorktree,
      [worktreeId]: tabs.map((tab) => (tab.id === tabId ? { ...tab, isPinned } : tab))
    }
  }
}

// Why: pin is host-authoritative for remote-server tabs, so mirror it to the
// host (like setTabColor) or it's lost on reconnect/restart/other clients.
// Dynamic import keeps this store slice off the runtime layer.
function mirrorTabPinnedToHost(state: AppState, tabId: string, isPinned: boolean): void {
  const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
  // Why: only terminal tab pins are persisted host-side today (browser/editor
  // tracked in #5729), so skip the RPC for other types instead of a no-op round
  // trip.
  if (
    !found ||
    found.tab.contentType !== 'terminal' ||
    !getRuntimeEnvironmentIdForWorktree(state, found.worktreeId)
  ) {
    return
  }
  const worktreeId = found.worktreeId
  void import('@/runtime/web-runtime-session').then(({ setWebRuntimeTabProps }) =>
    setWebRuntimeTabProps({ worktreeId, tabId, isPinned })
  )
}

// Why: viewMode is host-tracked like color/pin, so mirror the local toggle/set to
// the host or it's lost on reconnect/restart and never reaches paired clients.
// Only the user/RPC-set action path mirrors — never the reconcile that applies a
// host value — so the echoed snapshot can't re-trigger an outbound RPC (no loop).
function mirrorTabViewModeToHost(
  state: AppState,
  tabId: string,
  viewMode: 'terminal' | 'chat'
): void {
  const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
  // Why: only terminal tab viewMode is persisted host-side; skip the RPC for other
  // types instead of a no-op round trip.
  if (
    !found ||
    found.tab.contentType !== 'terminal' ||
    !getRuntimeEnvironmentIdForWorktree(state, found.worktreeId)
  ) {
    return
  }
  const worktreeId = found.worktreeId
  void import('@/runtime/web-runtime-session').then(({ setWebRuntimeTabProps }) =>
    setWebRuntimeTabProps({ worktreeId, tabId, viewMode })
  )
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

function partitionPinnedTabOrder(tabOrder: string[], tabs: Tab[], movingTabId: string): string[] {
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]))
  const withoutMoving = dedupeTabOrder(tabOrder).filter((id) => id !== movingTabId)
  const pinnedIds = withoutMoving.filter((id) => tabById.get(id)?.isPinned)
  const unpinnedIds = withoutMoving.filter((id) => !tabById.get(id)?.isPinned)
  return [...pinnedIds, movingTabId, ...unpinnedIds]
}

function applyTabOrderSortValues(tabs: Tab[], tabOrder: string[]): Tab[] {
  const orderMap = new Map(tabOrder.map((id, index) => [id, index]))
  return tabs.map((tab) => {
    const sortOrder = orderMap.get(tab.id)
    return sortOrder === undefined ? tab : { ...tab, sortOrder }
  })
}

function isReplaceablePreviewContentType(contentType: Tab['contentType']): boolean {
  return (
    contentType === 'editor' ||
    contentType === 'diff' ||
    contentType === 'conflict-review' ||
    contentType === 'check-details'
  )
}

function canReplacePreviewContentType(
  incomingContentType: Tab['contentType'],
  existingContentType: Tab['contentType']
): boolean {
  if (isReplaceablePreviewContentType(incomingContentType)) {
    return isReplaceablePreviewContentType(existingContentType)
  }
  return existingContentType === incomingContentType
}

export function findSiblingGroupId(root: TabGroupLayoutNode, targetGroupId: string): string | null {
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
  if (
    contentType === 'browser' ||
    contentType === 'terminal' ||
    contentType === 'simulator' ||
    contentType === 'tasks'
  ) {
    return contentType
  }
  return 'editor'
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
      activeUnifiedTab.contentType === 'conflict-review' ||
      activeUnifiedTab.contentType === 'check-details'
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

function activeSurfacePatchMatchesState(
  state: Pick<
    AppState,
    | 'activeBrowserTabId'
    | 'activeBrowserTabIdByWorktree'
    | 'activeFileId'
    | 'activeFileIdByWorktree'
    | 'activeTabId'
    | 'activeTabIdByWorktree'
    | 'activeTabType'
    | 'activeTabTypeByWorktree'
  >,
  worktreeId: string,
  patch: Pick<
    AppState,
    | 'activeBrowserTabId'
    | 'activeBrowserTabIdByWorktree'
    | 'activeFileId'
    | 'activeFileIdByWorktree'
    | 'activeTabId'
    | 'activeTabIdByWorktree'
    | 'activeTabType'
    | 'activeTabTypeByWorktree'
  >
): boolean {
  return (
    state.activeBrowserTabId === patch.activeBrowserTabId &&
    state.activeBrowserTabIdByWorktree[worktreeId] ===
      patch.activeBrowserTabIdByWorktree[worktreeId] &&
    state.activeFileId === patch.activeFileId &&
    state.activeFileIdByWorktree[worktreeId] === patch.activeFileIdByWorktree[worktreeId] &&
    state.activeTabId === patch.activeTabId &&
    state.activeTabIdByWorktree[worktreeId] === patch.activeTabIdByWorktree[worktreeId] &&
    state.activeTabType === patch.activeTabType &&
    state.activeTabTypeByWorktree[worktreeId] === patch.activeTabTypeByWorktree[worktreeId]
  )
}

export const createTabsSlice: StateCreator<AppState, [], [], TabsSlice> = (set, get) => ({
  unifiedTabsByWorktree: {},
  renamingTabId: null,
  groupsByWorktree: {},
  activeGroupIdByWorktree: {},
  layoutByWorktree: {},

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

      created = {
        id,
        entityId: init?.entityId ?? id,
        groupId: group.id,
        worktreeId,
        contentType,
        label:
          init?.label ?? (contentType === 'terminal' ? `Terminal ${existingTabs.length + 1}` : id),
        ...(init?.generatedLabel !== undefined ? { generatedLabel: init.generatedLabel } : {}),
        ...(init?.quickCommandLabel !== undefined
          ? { quickCommandLabel: init.quickCommandLabel }
          : {}),
        customLabel: init?.customLabel ?? null,
        color: init?.color ?? null,
        sortOrder: nextOrder.length,
        createdAt: Date.now(),
        isPreview: init?.isPreview,
        isPinned: init?.isPinned
      }

      nextOrder = dedupeTabOrder([...nextOrder, created.id])
      const shouldActivate = init?.activate ?? true
      const nextActiveTabId = shouldActivate ? created.id : (group.activeTabId ?? created.id)
      const sanitizedRecent = sanitizeRecentTabIds(group.recentTabIds, nextOrder)
      // Why: automation-created browser tabs need to exist and paint without
      // stealing the visible group selection from the user's current tab.
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
      const sourceGroup = findGroupForTab(state.groupsByWorktree, worktreeId, target.sourceGroupId)
      if (!sourceGroup) {
        return {}
      }
      const existingTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
      const currentGroups = state.groupsByWorktree[worktreeId] ?? []
      const shouldActivate = init?.activate ?? true
      const currentLayout =
        state.layoutByWorktree[worktreeId] ??
        ({ type: 'leaf', groupId: target.sourceGroupId } as const)
      const createdTab: Tab = {
        id,
        entityId: init?.entityId ?? id,
        groupId: newGroupId,
        worktreeId,
        contentType,
        label:
          init?.label ?? (contentType === 'terminal' ? `Terminal ${existingTabs.length + 1}` : id),
        ...(init?.generatedLabel !== undefined ? { generatedLabel: init.generatedLabel } : {}),
        ...(init?.quickCommandLabel !== undefined
          ? { quickCommandLabel: init.quickCommandLabel }
          : {}),
        customLabel: init?.customLabel ?? null,
        color: init?.color ?? null,
        sortOrder: 0,
        createdAt: Date.now(),
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

  activateTab: (tabId, opts) => {
    set((state) => {
      const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!found) {
        return {}
      }
      const { tab, worktreeId } = found
      // Why: activating a terminal tab dismisses the tab-level bell — the user
      // has now moved their eyes to this tab.
      //
      // Why (activeWorktree guard below): only dismiss the tab-level bell when
      // the tab is in the active worktree — otherwise the tab is not visible
      // yet and the signal would be lost before the user saw it. Mirrors the
      // guard in focusGroup.
      const terminalEntityId = tab.contentType === 'terminal' ? tab.entityId : null
      const nextUnreadTerminalTabs =
        state.activeWorktreeId === worktreeId &&
        terminalEntityId &&
        state.unreadTerminalTabs[terminalEntityId]
          ? (() => {
              const copy = { ...state.unreadTerminalTabs }
              delete copy[terminalEntityId]
              return copy
            })()
          : state.unreadTerminalTabs
      return {
        unifiedTabsByWorktree: opts?.preservePreview
          ? state.unifiedTabsByWorktree
          : {
              ...state.unifiedTabsByWorktree,
              [worktreeId]: (state.unifiedTabsByWorktree[worktreeId] ?? []).map((item) =>
                item.id === tabId ? { ...item, isPreview: false } : item
              )
            },
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [worktreeId]: (state.groupsByWorktree[worktreeId] ?? []).map((group) =>
            group.id === tab.groupId
              ? {
                  ...group,
                  activeTabId: tabId,
                  // Why: MRU tracks every activation within the group so
                  // closeUnifiedTab can jump back to the previous tab instead
                  // of the visual neighbor. Sanitize first to prune ids from
                  // removed tabs that may have lingered in persisted state.
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
        },
        // Why: skip writing unreadTerminalTabs when the reference is unchanged —
        // avoids a no-op top-level state allocation that would force re-evaluation
        // of full-state selectors. Mirrors focusGroup / reconcileWorktreeTabModel.
        ...(nextUnreadTerminalTabs !== state.unreadTerminalTabs
          ? { unreadTerminalTabs: nextUnreadTerminalTabs }
          : {})
      }
    })
  },

  closeUnifiedTab: (tabId, opts) => {
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

    const dedupedGroupOrder = dedupeTabOrder(group.tabOrder)
    const remainingOrder = dedupeTabOrder(dedupedGroupOrder.filter((id) => id !== tabId))
    const wasLastTab = remainingOrder.length === 0
    // Why: when closing the active tab, walk the group's MRU stack back to the
    // previously-active tab instead of the visual neighbor. `pickNextActiveTab`
    // falls back to pickNeighbor when the MRU is empty (hydrated sessions,
    // never-visited siblings) so behavior degrades gracefully.
    const nextActiveTabId =
      group.activeTabId === tabId
        ? wasLastTab
          ? null
          : pickNextActiveTab(dedupedGroupOrder, group.recentTabIds, tabId)
        : group.activeTabId
    const nextRecentTabIds = sanitizeRecentTabIds(
      (group.recentTabIds ?? []).filter((id) => id !== tabId),
      remainingOrder
    )
    const terminalEntityId = tab.contentType === 'terminal' ? tab.entityId : null

    set((current) => {
      const nextTabs = (current.unifiedTabsByWorktree[worktreeId] ?? []).filter(
        (item) => item.id !== tabId
      )
      // Why: closeUnifiedTab can be invoked without going through terminals.closeTab
      // (e.g., close-to-right / close-others gestures via closeOtherTabs and
      // closeTabsToRight). The unread-flag map is keyed by terminal entityId and
      // would otherwise leak a stale dot for a tab that no longer renders.
      let nextUnreadTerminalTabs = current.unreadTerminalTabs
      if (terminalEntityId && current.unreadTerminalTabs[terminalEntityId]) {
        nextUnreadTerminalTabs = { ...current.unreadTerminalTabs }
        delete nextUnreadTerminalTabs[terminalEntityId]
      }
      let nextGroups = (current.groupsByWorktree[worktreeId] ?? []).map((candidate) =>
        candidate.id === group.id
          ? {
              ...candidate,
              activeTabId: nextActiveTabId,
              tabOrder: remainingOrder,
              recentTabIds: nextRecentTabIds
            }
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
        // Why: skip writing unreadTerminalTabs when the reference is unchanged —
        // avoids a no-op top-level state allocation that would force re-evaluation
        // of full-state selectors. Mirrors focusGroup / reconcileWorktreeTabModel.
        ...(nextUnreadTerminalTabs !== current.unreadTerminalTabs
          ? { unreadTerminalTabs: nextUnreadTerminalTabs }
          : {}),
        // Why: the split-group model can legally derive "terminal with no
        // active tab" after the final unified tab closes. That leaves the
        // worktree selected but render-empty, so the workspace shows a blank
        // pane instead of Orca's landing screen. When that happens, write the
        // landing-state fallback directly instead of recomputing active-surface
        // fields from a worktree that is no longer active.
        ...(shouldDeactivateWorktree
          ? {
              activeWorktreeId: null,
              activeWorkspaceKey: null,
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

    if (opts?.recordInteraction !== false) {
      get().recordFeatureInteraction?.('terminal-tabs')
    }
    return { closedTabId: tabId, wasLastTab, worktreeId }
  },

  reorderUnifiedTabs: (groupId, tabIds, opts) => {
    let reordered = false
    set((state) => {
      for (const [worktreeId, groups] of Object.entries(state.groupsByWorktree)) {
        const group = groups.find((candidate) => candidate.id === groupId)
        if (!group) {
          continue
        }
        // Why: drag-and-drop should preserve a single canonical position for
        // each tab. Sanitizing here restores the invariant at the store
        // boundary so later group operations do not branch on duplicate ids.
        const nextTabOrder = dedupeTabOrder(tabIds)
        reordered = true
        const orderMap = new Map(nextTabOrder.map((id, index) => [id, index]))
        return {
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [worktreeId]: updateGroup(groups, { ...group, tabOrder: nextTabOrder })
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
    if (reordered && opts?.recordInteraction !== false) {
      get().recordFeatureInteraction?.('terminal-tabs')
    }
  },

  setTabLabel: (tabId, label) => {
    set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { label }) ?? {})
  },

  setTabViewMode: (tabId, mode) => {
    set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { viewMode: mode }) ?? {})
    mirrorTabViewModeToHost(get(), tabId, mode)
  },

  toggleTabViewMode: (tabId) => {
    let toggled: {
      from: 'terminal' | 'chat'
      to: 'terminal' | 'chat'
      agent: TuiAgent | null
    } | null = null
    set((state) => {
      const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!found) {
        return {}
      }
      // Why: default is 'terminal' for legacy/missing, so the first toggle flips
      // to 'chat'. patchTab mutates only this tab, leaving split siblings intact.
      const fromMode: 'terminal' | 'chat' = found.tab.viewMode === 'chat' ? 'chat' : 'terminal'
      const nextMode = fromMode === 'chat' ? 'terminal' : 'chat'
      // Why: `launchAgent` lives on the legacy terminal tab keyed by the unified
      // tab's entityId — resolve it here so the toggle telemetry can attribute
      // adoption by agent without threading it through every caller.
      const agent =
        (state.tabsByWorktree[found.worktreeId] ?? []).find(
          (terminal) => terminal.id === found.tab.entityId
        )?.launchAgent ?? null
      toggled = { from: fromMode, to: nextMode, agent }
      return patchTab(state.unifiedTabsByWorktree, tabId, { viewMode: nextMode }) ?? {}
    })
    // Why: emit after the state write so the event reflects the committed mode.
    const committed = toggled as {
      from: 'terminal' | 'chat'
      to: 'terminal' | 'chat'
      agent: TuiAgent | null
    } | null
    if (committed) {
      emitNativeChatToggled(committed)
      mirrorTabViewModeToHost(get(), tabId, committed.to)
    }
  },

  setRenamingTabId: (tabId) => {
    set({ renamingTabId: tabId })
  },

  setTabCustomLabel: (tabId, label, opts) => {
    const exists = get().getTab(tabId) !== null
    set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { customLabel: label }) ?? {})
    if (exists && opts?.recordInteraction !== false) {
      get().recordFeatureInteraction?.('terminal-tabs')
    }
  },

  setUnifiedTabColor: (tabId, color) => {
    const exists = get().getTab(tabId) !== null
    set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { color }) ?? {})
    if (exists) {
      get().recordFeatureInteraction?.('terminal-tabs')
    }
  },

  pinTab: (tabId) => {
    const exists = get().getTab(tabId) !== null
    set((state) => {
      const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!found) {
        return {}
      }
      const { tab, worktreeId } = found
      const tabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).map((candidate) =>
        candidate.id === tabId ? { ...candidate, isPinned: true, isPreview: false } : candidate
      )
      const groups = state.groupsByWorktree[worktreeId] ?? []
      const group = groups.find((candidate) => candidate.id === tab.groupId)
      if (!group) {
        return {
          unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [worktreeId]: tabs }
        }
      }
      const tabOrder = partitionPinnedTabOrder(group.tabOrder, tabs, tabId)
      return {
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [worktreeId]: applyTabOrderSortValues(tabs, tabOrder)
        },
        // Why: reconcile derives a tab's pin from the TerminalTab (tabsByWorktree),
        // so mirror the pin there too — otherwise an unrelated host snapshot
        // recomputes isPinned:false and visually un-pins during the echo window.
        ...patchTerminalTabPinned(state.tabsByWorktree, worktreeId, tabId, true),
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [worktreeId]: updateGroup(groups, { ...group, tabOrder })
        }
      }
    })
    mirrorTabPinnedToHost(get(), tabId, true)
    if (exists) {
      get().recordFeatureInteraction?.('terminal-tabs')
    }
  },

  unpinTab: (tabId) => {
    const exists = get().getTab(tabId) !== null
    set((state) => {
      const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!found) {
        return {}
      }
      const { tab, worktreeId } = found
      const tabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).map((candidate) =>
        candidate.id === tabId ? { ...candidate, isPinned: false } : candidate
      )
      const groups = state.groupsByWorktree[worktreeId] ?? []
      const group = groups.find((candidate) => candidate.id === tab.groupId)
      if (!group) {
        return {
          unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [worktreeId]: tabs }
        }
      }
      const tabOrder = partitionPinnedTabOrder(group.tabOrder, tabs, tabId)
      return {
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [worktreeId]: applyTabOrderSortValues(tabs, tabOrder)
        },
        ...patchTerminalTabPinned(state.tabsByWorktree, worktreeId, tabId, false),
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [worktreeId]: updateGroup(groups, { ...group, tabOrder })
        }
      }
    })
    mirrorTabPinnedToHost(get(), tabId, false)
    if (exists) {
      get().recordFeatureInteraction?.('terminal-tabs')
    }
  },

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

    const groupId = createBrowserUuid()
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
      const groupAlreadyFocused = state.activeGroupIdByWorktree[worktreeId] === groupId
      const nextActiveGroupIdByWorktree = groupAlreadyFocused
        ? state.activeGroupIdByWorktree
        : {
            ...state.activeGroupIdByWorktree,
            [worktreeId]: groupId
          }
      // Why: focusing a split group surfaces whichever terminal tab is already
      // active in that group, so the tab-level bell is no longer needed.
      //
      // Why (activeWorktree guard below): only clear unreadTerminalTabs when
      // focusing a group within the *active* worktree. If the caller is
      // focusing a group in a background worktree, that tab is not visible
      // yet — dismissing its bell here would silently swallow the signal
      // before the user ever sees the tab. All current callers only fire for
      // the active worktree, but this guard prevents future misuse.
      if (state.activeWorktreeId !== worktreeId) {
        if (groupAlreadyFocused) {
          return state
        }
        return {
          activeGroupIdByWorktree: nextActiveGroupIdByWorktree
        }
      }
      const groups = state.groupsByWorktree[worktreeId] ?? []
      const unifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
      const visibleTerminalEntityIds = new Set(
        groups
          .map((group) =>
            group.activeTabId ? unifiedTabs.find((tab) => tab.id === group.activeTabId) : null
          )
          .filter((tab): tab is (typeof unifiedTabs)[number] => tab?.contentType === 'terminal')
          .map((tab) => tab.entityId)
      )
      const nextUnreadTerminalTabs =
        visibleTerminalEntityIds.size > 0
          ? (() => {
              let changed = false
              const copy = { ...state.unreadTerminalTabs }
              for (const terminalEntityId of visibleTerminalEntityIds) {
                if (!copy[terminalEntityId]) {
                  continue
                }
                delete copy[terminalEntityId]
                changed = true
              }
              return changed ? copy : state.unreadTerminalTabs
            })()
          : state.unreadTerminalTabs
      const activeSurfacePatch = buildActiveSurfacePatch(
        {
          ...state,
          activeGroupIdByWorktree: nextActiveGroupIdByWorktree
        },
        worktreeId,
        groupId
      )
      if (
        groupAlreadyFocused &&
        nextUnreadTerminalTabs === state.unreadTerminalTabs &&
        activeSurfacePatchMatchesState(state, worktreeId, activeSurfacePatch)
      ) {
        return state
      }
      return {
        ...(groupAlreadyFocused ? {} : { activeGroupIdByWorktree: nextActiveGroupIdByWorktree }),
        // Why: only write unreadTerminalTabs back into state when it actually
        // changed. The IIFE above returns state.unreadTerminalTabs by reference
        // on no-op; preserving that reference via conditional spread keeps
        // downstream selectors/subscribers from firing spuriously. This matches
        // the pattern used by activateTab and closeUnifiedTab.
        ...(nextUnreadTerminalTabs !== state.unreadTerminalTabs
          ? { unreadTerminalTabs: nextUnreadTerminalTabs }
          : {}),
        ...activeSurfacePatch
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
      // Why: drop the dead group's recent-quick-command entry so the in-memory
      // map can't grow unbounded as users open/close groups.
      const { [groupId]: _droppedRecent, ...remainingRecent } = current.recentQuickCommandIdByGroup
      return {
        groupsByWorktree: { ...current.groupsByWorktree, [worktreeId]: remainingGroups },
        layoutByWorktree: collapsedState.layoutByWorktree,
        activeGroupIdByWorktree: collapsedState.activeGroupIdByWorktree,
        recentQuickCommandIdByGroup: remainingRecent,
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
    const newGroupId = createBrowserUuid()
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
    get().recordFeatureInteraction?.('terminal-panes')
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

      const dedupedSourceGroupOrder = dedupeTabOrder(sourceGroup.tabOrder)
      const sourceOrder = dedupeTabOrder(dedupedSourceGroupOrder.filter((id) => id !== tabId))
      // Why: defensive filter so target order can't grow a duplicate if the
      // tab id somehow already exists there (stale state, prior bug). See
      // dropUnifiedTab for the same guard.
      const targetOrder = dedupeTabOrder(targetGroup.tabOrder.filter((id) => id !== tabId))
      const targetIndex = Math.max(
        0,
        Math.min(opts?.index ?? targetOrder.length, targetOrder.length)
      )
      targetOrder.splice(targetIndex, 0, tabId)
      const nextActiveGroupIdByWorktree = {
        ...state.activeGroupIdByWorktree,
        [worktreeId]: opts?.activate ? targetGroupId : state.activeGroupIdByWorktree[worktreeId]
      }
      const sourceRecentTabIds = sanitizeRecentTabIds(
        (sourceGroup.recentTabIds ?? []).filter((id) => id !== tabId),
        sourceOrder
      )
      const nextGroups = (state.groupsByWorktree[worktreeId] ?? []).map((group) => {
        if (group.id === sourceGroup.id) {
          return {
            ...group,
            activeTabId:
              group.activeTabId === tabId
                ? // Why: when the moved tab was active in the source, keep
                  // MRU-aware selection so the user lands on their previously
                  // focused tab rather than a visual neighbor.
                  pickNextActiveTab(dedupedSourceGroupOrder, sourceGroup.recentTabIds, tabId)
                : group.activeTabId,
            tabOrder: sourceOrder,
            recentTabIds: sourceRecentTabIds
          }
        }
        if (group.id === targetGroupId) {
          const sanitizedTargetRecent = sanitizeRecentTabIds(group.recentTabIds, targetOrder)
          return {
            ...group,
            activeTabId: opts?.activate ? tabId : group.activeTabId,
            tabOrder: targetOrder,
            recentTabIds: opts?.activate
              ? pushRecentTabId(sanitizedTargetRecent, tabId)
              : sanitizedTargetRecent
          }
        }
        return group
      })
      let nextLayoutByWorktree = state.layoutByWorktree
      let nextActiveGroupIdByWorktreeResolved = nextActiveGroupIdByWorktree
      let filteredGroups = nextGroups
      if (sourceOrder.length === 0) {
        filteredGroups = nextGroups.filter((group) => group.id !== sourceGroup.id)
        const collapsedState = collapseGroupLayout(
          nextLayoutByWorktree,
          nextActiveGroupIdByWorktreeResolved,
          worktreeId,
          sourceGroup.id,
          targetGroupId
        )
        nextLayoutByWorktree = collapsedState.layoutByWorktree
        nextActiveGroupIdByWorktreeResolved = collapsedState.activeGroupIdByWorktree
      }
      const nextGroupsByWorktree = {
        ...state.groupsByWorktree,
        [worktreeId]: filteredGroups
      }
      const nextUnifiedTabsByWorktree = {
        ...state.unifiedTabsByWorktree,
        [worktreeId]: (state.unifiedTabsByWorktree[worktreeId] ?? []).map((candidate) =>
          candidate.id === tabId ? { ...candidate, groupId: targetGroupId } : candidate
        )
      }
      return {
        unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
        groupsByWorktree: nextGroupsByWorktree,
        layoutByWorktree: nextLayoutByWorktree,
        activeGroupIdByWorktree: nextActiveGroupIdByWorktreeResolved,
        ...(state.activeWorktreeId === worktreeId
          ? buildActiveSurfacePatch(
              {
                ...state,
                unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
                groupsByWorktree: nextGroupsByWorktree,
                layoutByWorktree: nextLayoutByWorktree,
                activeGroupIdByWorktree: nextActiveGroupIdByWorktreeResolved
              },
              worktreeId,
              nextActiveGroupIdByWorktreeResolved[worktreeId] ?? null
            )
          : {})
      }
    })
    if (moved && opts?.recordInteraction !== false) {
      get().recordFeatureInteraction?.('tab-splits')
    }
    return moved
  },

  dropUnifiedTab: (tabId, target) => {
    let moved = false
    set((state) => {
      const foundTab = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      const foundTarget = findGroupAndWorktree(state.groupsByWorktree, target.groupId)
      if (!foundTab || !foundTarget || foundTab.worktreeId !== foundTarget.worktreeId) {
        return {}
      }

      const { tab, worktreeId } = foundTab
      const sourceGroup = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
      const targetGroup = foundTarget.group
      if (!sourceGroup) {
        return {}
      }

      const isSplitDrop = Boolean(target.splitDirection)
      if (!isSplitDrop && tab.groupId === target.groupId) {
        return {}
      }
      const layout = state.layoutByWorktree[worktreeId]
      if (
        isSplitDrop &&
        isPaneColumnSplitDropNoOp({
          sourceGroupId: sourceGroup.id,
          targetGroupId: target.groupId,
          splitDirection: target.splitDirection!,
          sourceTabCount: sourceGroup.tabOrder.length,
          layout
        })
      ) {
        // Why: dragging the final tab in a group onto that same group's edge,
        // or onto the adjacent sibling's matching edge, creates a transient
        // column only to collapse the emptied source immediately.
        return {}
      }

      moved = true

      let nextGroups = state.groupsByWorktree[worktreeId] ?? []
      let nextLayoutByWorktree = state.layoutByWorktree
      let nextActiveGroupIdByWorktree = state.activeGroupIdByWorktree
      let resolvedTargetGroupId = target.groupId

      if (target.splitDirection) {
        const newGroupId = createBrowserUuid()
        const newGroup: TabGroup = {
          id: newGroupId,
          worktreeId,
          activeTabId: null, // Placeholder; properly set in the nextGroups.map() below
          tabOrder: []
        }
        const currentLayout =
          nextLayoutByWorktree[worktreeId] ?? ({ type: 'leaf', groupId: target.groupId } as const)
        const replacement = buildSplitNode(
          target.groupId,
          newGroupId,
          target.splitDirection === 'left' || target.splitDirection === 'right'
            ? 'horizontal'
            : 'vertical',
          target.splitDirection === 'left' || target.splitDirection === 'up' ? 'first' : 'second'
        )

        resolvedTargetGroupId = newGroupId
        nextGroups = [...nextGroups, newGroup]
        nextLayoutByWorktree = {
          ...nextLayoutByWorktree,
          [worktreeId]: replaceLeaf(currentLayout, target.groupId, replacement)
        }
        nextActiveGroupIdByWorktree = {
          ...nextActiveGroupIdByWorktree,
          [worktreeId]: newGroupId
        }
      }

      const dedupedSourceGroupOrder = dedupeTabOrder(sourceGroup.tabOrder)
      const sourceOrder = dedupeTabOrder(dedupedSourceGroupOrder.filter((id) => id !== tabId))
      const destinationGroup =
        nextGroups.find((group) => group.id === resolvedTargetGroupId) ?? targetGroup
      // Why: the target group's stored order can already contain this tab id
      // from a prior racey write or a same-group split where the source and
      // destination transiently share it. Splicing without filtering first
      // would leave the same id in the order twice, which React surfaces as
      // a duplicate-key warning in TabBar and can mis-reconcile xterm panes.
      const targetOrder = dedupeTabOrder(destinationGroup.tabOrder.filter((id) => id !== tabId))
      const targetIndex = Math.max(
        0,
        Math.min(target.index ?? targetOrder.length, targetOrder.length)
      )
      targetOrder.splice(targetIndex, 0, tabId)

      const sourceRecentTabIds = sanitizeRecentTabIds(
        (sourceGroup.recentTabIds ?? []).filter((id) => id !== tabId),
        sourceOrder
      )
      nextGroups = nextGroups.map((group) => {
        if (group.id === sourceGroup.id) {
          return {
            ...group,
            activeTabId:
              group.activeTabId === tabId
                ? // Why: same MRU-aware fallback as moveUnifiedTabToGroup so
                  // the pane left behind by a drag keeps the user on their
                  // previously-active tab.
                  pickNextActiveTab(dedupedSourceGroupOrder, sourceGroup.recentTabIds, tabId)
                : group.activeTabId,
            tabOrder: sourceOrder,
            recentTabIds: sourceRecentTabIds
          }
        }
        if (group.id === resolvedTargetGroupId) {
          return {
            ...group,
            activeTabId: tabId,
            tabOrder: targetOrder,
            recentTabIds: pushRecentTabId(
              sanitizeRecentTabIds(group.recentTabIds, targetOrder),
              tabId
            )
          }
        }
        return group
      })

      if (sourceOrder.length === 0) {
        nextGroups = nextGroups.filter((group) => group.id !== sourceGroup.id)
        const collapsedState = collapseGroupLayout(
          nextLayoutByWorktree,
          nextActiveGroupIdByWorktree,
          worktreeId,
          sourceGroup.id,
          resolvedTargetGroupId
        )
        nextLayoutByWorktree = collapsedState.layoutByWorktree
        nextActiveGroupIdByWorktree = collapsedState.activeGroupIdByWorktree
      } else {
        nextActiveGroupIdByWorktree = {
          ...nextActiveGroupIdByWorktree,
          [worktreeId]: resolvedTargetGroupId
        }
      }

      const nextUnifiedTabsByWorktree = {
        ...state.unifiedTabsByWorktree,
        [worktreeId]: (state.unifiedTabsByWorktree[worktreeId] ?? []).map((candidate) =>
          candidate.id === tabId ? { ...candidate, groupId: resolvedTargetGroupId } : candidate
        )
      }
      const nextGroupsByWorktree = {
        ...state.groupsByWorktree,
        [worktreeId]: nextGroups
      }

      return {
        unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
        groupsByWorktree: nextGroupsByWorktree,
        layoutByWorktree: nextLayoutByWorktree,
        activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
        ...(state.activeWorktreeId === worktreeId
          ? buildActiveSurfacePatch(
              {
                ...state,
                unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
                groupsByWorktree: nextGroupsByWorktree,
                layoutByWorktree: nextLayoutByWorktree,
                activeGroupIdByWorktree: nextActiveGroupIdByWorktree
              },
              worktreeId,
              resolvedTargetGroupId
            )
          : {})
      }
    })
    if (moved) {
      get().recordFeatureInteraction?.('terminal-tabs')
      get().recordFeatureInteraction?.('tab-splits')
    }
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
      generatedLabel: init?.generatedLabel ?? tab.generatedLabel,
      quickCommandLabel: init?.quickCommandLabel ?? tab.quickCommandLabel,
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
      get().moveUnifiedTabToGroup(item.id, targetGroupId, { recordInteraction: false })
    }
    get().closeEmptyGroup(worktreeId, groupId)
    get().recordFeatureInteraction?.('terminal-panes')
    return targetGroupId
  },

  setTabGroupSplitRatio: (worktreeId, nodePath, ratio) => {
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
    })
  },

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
      // Why: this is a one-shot migration filter for tabs not yet promoted
      // to unifiedTabs — keeping the wake-hint `tab.ptyId` clause is
      // intentional. tab.ptyId is the preserved sessionId (so wake can
      // reattach to the same daemon-history dir / relay session); a slept
      // tab will have `livePtyIds` empty *and* `tab.ptyId` populated, and
      // we want it included in the migration sweep so reconcile picks it
      // up. Reconcile fires again post-reattach, so the eventual live PTY
      // also routes through this branch. Do *not* repurpose this as an
      // "is this tab alive?" check — those reads must use ptyIdsByTabId.
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
              ...(tab.quickCommandLabel?.trim()
                ? { quickCommandLabel: tab.quickCommandLabel.trim() }
                : {}),
              ...(tab.generatedTitle?.trim() ? { generatedLabel: tab.generatedTitle.trim() } : {}),
              customLabel: tab.customTitle,
              color: tab.color,
              sortOrder: tab.sortOrder,
              createdAt: tab.createdAt
            }))
    const reconciledUnifiedTabs =
      restoredLegacyTabs.length > 0 ? [...unifiedTabs, ...restoredLegacyTabs] : unifiedTabs
    // Why: when a freshly-ensured group has no active tab yet, seed it from the
    // worktree's remembered selection before the first restored tab. Otherwise
    // returning to a worktree whose terminals only exist in the runtime slice
    // always reopens on Terminal 1 and drops the tab the user left on.
    const rememberedLegacyActiveTabId = state.activeTabIdByWorktree[worktreeId]
    const restoredLegacyTabIds = new Set(restoredLegacyTabs.map((tab) => tab.id))
    const legacyFallbackActiveTabId =
      rememberedLegacyActiveTabId && restoredLegacyTabIds.has(rememberedLegacyActiveTabId)
        ? rememberedLegacyActiveTabId
        : (restoredLegacyTabs[0]?.id ?? null)
    const reconciledGroups =
      restoredLegacyTabs.length > 0 && reconciliationGroup
        ? updateGroup(ensuredGroupState!.groupsByWorktree[worktreeId] ?? [], {
            ...reconciliationGroup,
            // Why: legacy terminal tabs can still exist in the runtime slice
            // after split groups became the source of truth. Restoring them
            // into the active/root group keeps existing live PTYs reachable
            // instead of making activation spawn a duplicate "Terminal 2".
            activeTabId: reconciliationGroup.activeTabId ?? legacyFallbackActiveTabId,
            tabOrder: dedupeTabOrder([
              ...reconciliationGroup.tabOrder,
              ...restoredLegacyTabs.map((tab) => tab.id)
            ])
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
      // Why: simulator and tasks panes have no runtime/file liveness set to
      // check (unlike terminal/browser/editor); their tab is always renderable.
      if (tab.contentType === 'simulator' || tab.contentType === 'tasks') {
        return true
      }
      return liveEditorIds.has(tab.entityId)
    }

    const validTabs = reconciledUnifiedTabs.filter(isRenderableTab)
    const validTabIds = new Set(validTabs.map((tab) => tab.id))

    const nextGroupsWithEmpty = reconciledGroups.map((group) => {
      const tabOrder = group.tabOrder.filter((tabId) => validTabIds.has(tabId))
      const activeTabId =
        group.activeTabId && validTabIds.has(group.activeTabId)
          ? group.activeTabId
          : (tabOrder[0] ?? null)
      const tabOrderUnchanged =
        tabOrder.length === group.tabOrder.length &&
        tabOrder.every((tabId, index) => tabId === group.tabOrder[index])
      // Why: reconciliation can drop backing tabs (stale persisted ids, dead
      // PTYs, closed editor files). Keep the MRU stack in sync so the next
      // close doesn't try to activate a tab the renderer no longer owns.
      const recentTabIds = sanitizeRecentTabIds(group.recentTabIds, tabOrder)
      const recentUnchanged =
        recentTabIds.length === (group.recentTabIds ?? []).length &&
        recentTabIds.every((id, index) => id === (group.recentTabIds ?? [])[index])
      return tabOrderUnchanged && activeTabId === group.activeTabId && recentUnchanged
        ? group
        : { ...group, tabOrder, activeTabId, recentTabIds }
    })
    const nextGroups =
      validTabs.length > 0
        ? nextGroupsWithEmpty.filter((group) => group.tabOrder.length > 0)
        : nextGroupsWithEmpty

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

    const baseNextLayout =
      restoredLegacyTabs.length > 0 && reconciliationGroup
        ? (state.layoutByWorktree[worktreeId] ?? { type: 'leaf', groupId: reconciliationGroup.id })
        : state.layoutByWorktree[worktreeId]
    const validGroupIds = new Set(nextGroups.map((group) => group.id))
    const prunedNextLayout =
      baseNextLayout && validGroupIds.size > 0
        ? pruneTabGroupLayoutForGroups(baseNextLayout, validGroupIds)
        : baseNextLayout
    const nextLayout =
      prunedNextLayout ?? (nextGroups[0] ? { type: 'leaf', groupId: nextGroups[0].id } : undefined)
    const currentLayout = state.layoutByWorktree[worktreeId]
    const layoutChanged = nextLayout !== currentLayout

    if (
      tabsChanged ||
      groupsChanged ||
      activeGroupChanged ||
      layoutChanged ||
      orphanTerminalIds.size > 0
    ) {
      // Why: when reconcile drops a unified terminal tab (stale persisted id,
      // dead PTY, closed editor), its entry in unreadTerminalTabs (keyed by the
      // terminal tab's entityId) would otherwise linger forever and bleed into
      // downstream persistence/selectors. Mirrors the cleanup in closeUnifiedTab
      // which removes the unread flag when a terminal tab is torn down.
      const droppedTerminalEntityIds: string[] = []
      for (const tab of unifiedTabs) {
        if (tab.contentType !== 'terminal') {
          continue
        }
        if (!validTabIds.has(tab.id)) {
          droppedTerminalEntityIds.push(tab.entityId)
        }
      }
      set((current) => {
        let nextUnreadTerminalTabs = current.unreadTerminalTabs
        if (droppedTerminalEntityIds.length > 0) {
          let changed = false
          const copy = { ...current.unreadTerminalTabs }
          for (const entityId of droppedTerminalEntityIds) {
            if (copy[entityId]) {
              delete copy[entityId]
              changed = true
            }
          }
          if (changed) {
            nextUnreadTerminalTabs = copy
          }
        }
        return {
          unifiedTabsByWorktree: { ...current.unifiedTabsByWorktree, [worktreeId]: validTabs },
          groupsByWorktree: { ...current.groupsByWorktree, [worktreeId]: nextGroups },
          activeGroupIdByWorktree: {
            ...current.activeGroupIdByWorktree,
            [worktreeId]: nextActiveGroupId
          },
          ...(nextUnreadTerminalTabs !== current.unreadTerminalTabs
            ? { unreadTerminalTabs: nextUnreadTerminalTabs }
            : {}),
          ...(nextLayout && layoutChanged
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
        }
      })
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

  hydrateTabsSession: (session, options) => {
    const state = get()
    const validWorktreeIds = new Set(
      Object.values(state.worktreesByRepo)
        .flat()
        .map((w) => w.id)
    )
    validWorktreeIds.add(FLOATING_TERMINAL_WORKTREE_ID)
    for (const workspace of state.folderWorkspaces) {
      validWorktreeIds.add(folderWorkspaceKey(workspace.id))
    }
    addAdditionalValidWorkspaceKeys(validWorktreeIds, options)
    set(buildHydratedTabState(session, validWorktreeIds))
  }
})
