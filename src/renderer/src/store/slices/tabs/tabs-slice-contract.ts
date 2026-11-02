import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type {
  Tab,
  TabContentType,
  TabGroup,
  TabGroupLayoutNode
} from '../../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session-state-types'
import type { WorkspaceSessionHydrationOptions } from '@/lib/workspace-session-hydration-keys'

export type TabSplitDirection = 'left' | 'right' | 'up' | 'down'

/** A new group beside `sourceGroupId`, created in the same update as the tab that fills it. */
export type TabSplitTarget = {
  sourceGroupId: string
  splitDirection: TabSplitDirection
  /** false leaves the worktree's active group where it was. */
  activate?: boolean
}

export type TabDragActivationSnapshot = {
  activeGroupId: string | null
  activeTabIdByGroup: Record<string, string | null>
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
        /** Creates the tab in a new split group instead; wins over targetGroupId. */
        split: TabSplitTarget
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
    target: Omit<TabSplitTarget, 'activate'>,
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
    /** `layoutOwnerHandled`: the caller already asked main for this order, or main cannot take it. */
    opts?: { recordInteraction?: boolean; layoutOwnerHandled?: boolean }
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
    opts?: { index?: number; activate?: boolean; recordInteraction?: boolean }
  ) => boolean
  dropUnifiedTab: (
    tabId: string,
    target: {
      groupId: string
      index?: number
      splitDirection?: TabSplitDirection
      /** The split's new group id, as main minted it; layout-owner builds only. */
      newGroupId?: string
    }
  ) => boolean
  setTabGroupSplitRatio: (worktreeId: string, nodePath: string, ratio: number) => void
  /** Selects the hovered tab while a drag is in flight; restored from the drag-start snapshot. */
  previewDragActiveTab: (args: {
    worktreeId: string
    groupId: string
    tabId: string | null
    activeGroupId: string
  }) => void
  restoreDragActivationSnapshot: (worktreeId: string, snapshot: TabDragActivationSnapshot) => void
  restoreSourceGroupActiveTabAfterDrop: (args: {
    worktreeId: string
    snapshot: TabDragActivationSnapshot
    sourceGroupId: string
    movedTabId: string
  }) => void
  reconcileWorktreeTabModel: (worktreeId: string) => {
    renderableTabCount: number
    activeRenderableTabId: string | null
  }
  /** Reconciles many workspaces through one store write instead of one per workspace. */
  reconcileWorktreeTabModels: (worktreeIds: readonly string[]) => void
  hydrateTabsSession: (
    session: WorkspaceSessionState,
    options?: WorkspaceSessionHydrationOptions
  ) => void
}

type TabsStateCreator = StateCreator<AppState, [], [], TabsSlice>
export type TabsSliceSet = Parameters<TabsStateCreator>[0]
export type TabsSliceGet = Parameters<TabsStateCreator>[1]
