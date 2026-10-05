import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type {
  Tab,
  TabContentType,
  TabGroup,
  TabGroupLayoutNode
} from '../../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session-state-types'
import type { RuntimeSessionTabChatView } from '../../../../../shared/runtime-session-contracts'
import type { TerminalChatPair } from '../../../../../shared/terminal-tab-view-mode'
import type { WorkspaceSessionHydrationOptions } from '@/lib/workspace-session-hydration-keys'

export type TabSplitDirection = 'left' | 'right' | 'up' | 'down'

export type TabsSlice = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
  /** Paired worktrees whose latest applied host snapshot says the host owns the chat pair. */
  chatViewHostOwnedByWorktree: Record<string, true>
  /** This desktop's unconfirmed chat-pair writes on host-owned worktrees, by terminal tab id. */
  pendingChatPairByTabId: Record<string, TerminalChatPair>
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
  /**
   * Writes a terminal tab's whole chat pair (unified + row `viewMode`, layout owner) in one
   * update. `leafId` null addresses the parent. Returns the pair the store then holds.
   */
  applyTerminalChatPair: (
    terminalTabId: string,
    leafId: string | null,
    mode: 'terminal' | 'chat',
    options?: {
      userToggle?: boolean
      /** A host relay's owner for a parent-addressed chat, used only when the tab has none;
       *  null: no pane of a split may own chat. */
      ownerPickLeafId?: string | null
    }
  ) => RuntimeSessionTabChatView | null
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
  hydrateTabsSession: (
    session: WorkspaceSessionState,
    options?: WorkspaceSessionHydrationOptions
  ) => void
}

type TabsStateCreator = StateCreator<AppState, [], [], TabsSlice>
export type TabsSliceSet = Parameters<TabsStateCreator>[0]
export type TabsSliceGet = Parameters<TabsStateCreator>[1]
