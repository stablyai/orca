import React from 'react';
import type { BrowserTab as BrowserTabState, TerminalTab, WorkspaceVisibleTabType } from '../../../../shared/types';
import type { OpenFile } from '../../store/slices/editor';
type TabBarProps = {
    tabs: (TerminalTab & {
        unifiedTabId?: string;
    })[];
    activeTabId: string | null;
    groupId?: string;
    worktreeId: string;
    expandedPaneByTabId: Record<string, boolean>;
    onActivate: (tabId: string) => void;
    onClose: (tabId: string) => void;
    onCloseOthers: (tabId: string) => void;
    onCloseToRight: (tabId: string) => void;
    onNewTerminalTab: () => void;
    onNewBrowserTab: () => void;
    onNewFileTab?: () => void;
    onSetCustomTitle: (tabId: string, title: string | null) => void;
    onSetTabColor: (tabId: string, color: string | null) => void;
    onTogglePaneExpand: (tabId: string) => void;
    editorFiles?: (OpenFile & {
        tabId?: string;
    })[];
    browserTabs?: (BrowserTabState & {
        tabId?: string;
    })[];
    activeFileId?: string | null;
    activeBrowserTabId?: string | null;
    activeTabType?: WorkspaceVisibleTabType;
    onActivateFile?: (fileId: string) => void;
    onCloseFile?: (fileId: string) => void;
    onActivateBrowserTab?: (tabId: string) => void;
    onCloseBrowserTab?: (tabId: string) => void;
    onCloseAllFiles?: () => void;
    onPinFile?: (fileId: string, tabId?: string) => void;
    tabBarOrder?: string[];
    onCreateSplitGroup?: (direction: 'left' | 'right' | 'up' | 'down', sourceVisibleTabId?: string) => void;
};
declare function TabBarInner({ tabs, activeTabId, groupId, worktreeId, expandedPaneByTabId, onActivate, onClose, onCloseOthers, onCloseToRight, onNewTerminalTab, onNewBrowserTab, onNewFileTab, onSetCustomTitle, onSetTabColor, onTogglePaneExpand, editorFiles, browserTabs, activeFileId, activeBrowserTabId, activeTabType, onActivateFile, onCloseFile, onActivateBrowserTab, onCloseBrowserTab, onCloseAllFiles, onPinFile, tabBarOrder, onCreateSplitGroup }: TabBarProps): React.JSX.Element;
declare const _default: React.MemoExoticComponent<typeof TabBarInner>;
export default _default;
