import type { StateCreator } from 'zustand';
import type { AppState } from '../types';
import type { Tab, TabContentType, TabGroup, TabGroupLayoutNode, WorkspaceSessionState } from '../../../../shared/types';
export type TabSplitDirection = 'left' | 'right' | 'up' | 'down';
export type TabsSlice = {
    unifiedTabsByWorktree: Record<string, Tab[]>;
    groupsByWorktree: Record<string, TabGroup[]>;
    activeGroupIdByWorktree: Record<string, string>;
    layoutByWorktree: Record<string, TabGroupLayoutNode>;
    createUnifiedTab: (worktreeId: string, contentType: TabContentType, init?: Partial<Pick<Tab, 'id' | 'entityId' | 'label' | 'customLabel' | 'color' | 'isPreview' | 'isPinned'> & {
        targetGroupId: string;
    }>) => Tab;
    getTab: (tabId: string) => Tab | null;
    getActiveTab: (worktreeId: string) => Tab | null;
    findTabForEntityInGroup: (worktreeId: string, groupId: string, entityId: string, contentType?: TabContentType) => Tab | null;
    activateTab: (tabId: string) => void;
    closeUnifiedTab: (tabId: string) => {
        closedTabId: string;
        wasLastTab: boolean;
        worktreeId: string;
    } | null;
    reorderUnifiedTabs: (groupId: string, tabIds: string[]) => void;
    setTabLabel: (tabId: string, label: string) => void;
    setTabCustomLabel: (tabId: string, label: string | null) => void;
    setUnifiedTabColor: (tabId: string, color: string | null) => void;
    pinTab: (tabId: string) => void;
    unpinTab: (tabId: string) => void;
    closeOtherTabs: (tabId: string) => string[];
    closeTabsToRight: (tabId: string) => string[];
    ensureWorktreeRootGroup: (worktreeId: string) => string;
    focusGroup: (worktreeId: string, groupId: string) => void;
    closeEmptyGroup: (worktreeId: string, groupId: string) => boolean;
    createEmptySplitGroup: (worktreeId: string, sourceGroupId: string, direction: TabSplitDirection) => string | null;
    moveUnifiedTabToGroup: (tabId: string, targetGroupId: string, opts?: {
        index?: number;
        activate?: boolean;
    }) => boolean;
    dropUnifiedTab: (tabId: string, target: {
        groupId: string;
        index?: number;
        splitDirection?: TabSplitDirection;
    }) => boolean;
    copyUnifiedTabToGroup: (tabId: string, targetGroupId: string, init?: Partial<Pick<Tab, 'id' | 'entityId' | 'label' | 'customLabel' | 'color' | 'isPinned'>>) => Tab | null;
    mergeGroupIntoSibling: (worktreeId: string, groupId: string) => string | null;
    setTabGroupSplitRatio: (worktreeId: string, nodePath: string, ratio: number) => void;
    reconcileWorktreeTabModel: (worktreeId: string) => {
        renderableTabCount: number;
        activeRenderableTabId: string | null;
    };
    hydrateTabsSession: (session: WorkspaceSessionState) => void;
};
export declare const createTabsSlice: StateCreator<AppState, [], [], TabsSlice>;
