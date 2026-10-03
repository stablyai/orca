import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type {
  Tab,
  TabCluster,
  TabClusterColor,
  TabContentType,
  TabGroup,
  TabGroupLayoutNode
} from '../../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session-state-types'
import type { WorkspaceSessionHydrationOptions } from '@/lib/workspace-session-hydration-keys'

export type TabSplitDirection = 'left' | 'right' | 'up' | 'down'

/** Transient (never persisted) highlighted tabs of one pane strip. */
export type TabStripSelection = {
  /** Highlighted unified tab ids of the pane. */
  tabIds: string[]
  /** Shift-click range origin. */
  anchorTabId: string | null
}

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
        | 'id'
        | 'entityId'
        | 'executionHostId'
        | 'agentSessionAgent'
        | 'label'
        | 'generatedLabel'
        | 'quickCommandLabel'
        | 'customLabel'
        | 'color'
        | 'isPreview'
        | 'isPinned'
      > & {
        targetGroupId: string
        /** Client-local unified tab id to insert after; an explicit targetGroupId still wins. */
        afterTabId: string
        activate: boolean
        /** false selects an activated tab without stamping its focus time (the group history still updates). */
        recordFocus: boolean
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
        | 'executionHostId'
        | 'agentSessionAgent'
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
  activateTab: (
    tabId: string,
    /** recordFocus false skips the focus-time stamp (not a user visit); the group history still updates. */
    opts?: { preservePreview?: boolean; worktreeId?: string; recordFocus?: boolean }
  ) => void
  closeUnifiedTab: (
    tabId: string,
    opts?: {
      /** Keep the worktree selected even if this empties it — for closes the user did not ask for. */
      preserveWorktreeSelection?: boolean
      recordInteraction?: boolean
      terminalRetirementHandled?: boolean
    }
  ) => { closedTabId: string; wasLastTab: boolean; worktreeId: string } | null
  reorderUnifiedTabs: (
    groupId: string,
    tabIds: string[],
    opts?: { recordInteraction?: boolean }
  ) => void
  setTabLabel: (tabId: string, label: string) => void
  /** Set a tab's view mode (terminal vs native chat). Patches only that tab. */
  setTabViewMode: (tabId: string, mode: 'terminal' | 'chat') => void
  /** Flip a tab between terminal and native-chat renderings; the live TerminalPane stays mounted. */
  toggleTabViewMode: (tabId: string) => void
  setTabCustomLabel: (
    tabId: string,
    label: string | null,
    opts?: { recordInteraction?: boolean }
  ) => void
  setUnifiedTabColor: (tabId: string, color: string | null) => void
  pinTab: (tabId: string) => void
  unpinTab: (tabId: string) => void
  closeOtherTabs: (tabId: string) => string[]
  closeTabsToRight: (tabId: string) => string[]
  closeTabsToLeft: (tabId: string) => string[]
  ensureWorktreeRootGroup: (worktreeId: string) => string
  focusGroup: (worktreeId: string, groupId: string) => void
  closeEmptyGroup: (worktreeId: string, groupId: string) => boolean
  createEmptySplitGroup: (
    worktreeId: string,
    sourceGroupId: string,
    direction: TabSplitDirection,
    opts?: { activate?: boolean }
  ) => string | null
  moveUnifiedTabToGroup: (
    tabId: string,
    targetGroupId: string,
    opts?: {
      index?: number
      activate?: boolean
      recordInteraction?: boolean
    }
  ) => boolean
  dropUnifiedTab: (
    tabId: string,
    target: {
      groupId: string
      index?: number
      splitDirection?: TabSplitDirection
      /** Destination membership; ignored when creating a split. */
      clusterId?: string | null
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
  /** Reconciles many workspaces through one store write instead of one per workspace. */
  reconcileWorktreeTabModels: (worktreeIds: readonly string[]) => void
  /** Keyed by pane (TabGroup) id. */
  tabSelectionByGroupId: Record<string, TabStripSelection>
  /** null clears the pane's selection. */
  setTabSelection: (groupId: string, selection: TabStripSelection | null) => void
  /** Preserves untouched source groups when gathering selected tabs. Returns the new cluster id. */
  createTabCluster: (
    groupId: string,
    tabIds: string[],
    init?: { name?: string; color?: TabClusterColor }
  ) => string | null
  /** Moves the tabs to the cluster's end and joins them. */
  addTabsToCluster: (groupId: string, clusterId: string, tabIds: string[]) => boolean
  /** Moves members just past their cluster's end and drops their membership. */
  removeTabsFromCluster: (groupId: string, tabIds: string[]) => void
  renameTabCluster: (groupId: string, clusterId: string, name: string) => void
  setTabClusterColor: (groupId: string, clusterId: string, color: TabClusterColor) => void
  setTabClusterCollapsed: (groupId: string, clusterId: string, collapsed: boolean) => void
  /** Double-click rename must undo collapse without recapturing the current active member. */
  restoreTabClusterCollapseState: (
    groupId: string,
    clusterId: string,
    snapshot: Pick<TabCluster, 'collapsed' | 'shownTabId'>
  ) => void
  /** Drops the cluster; its tabs stay open in place. */
  ungroupTabCluster: (groupId: string, clusterId: string) => void
  /** Atomic same-pane reorder that also sets membership (null = ungrouped) of the moved tabs. */
  moveTabsInStrip: (
    groupId: string,
    tabIds: string[],
    target: { index: number; clusterId: string | null }
  ) => void
  /** Moves every member and its cluster record to another pane or a new split. */
  moveTabCluster: (
    sourceGroupId: string,
    clusterId: string,
    target: { groupId: string; index?: number; splitDirection?: TabSplitDirection }
  ) => boolean
  hydrateTabsSession: (
    session: WorkspaceSessionState,
    options?: WorkspaceSessionHydrationOptions
  ) => void
}

type TabsStateCreator = StateCreator<AppState, [], [], TabsSlice>
export type TabsSliceSet = Parameters<TabsStateCreator>[0]
export type TabsSliceGet = Parameters<TabsStateCreator>[1]
