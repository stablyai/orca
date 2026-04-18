import type { OpenFile } from '@/store/slices/editor';
import type { BrowserTab as BrowserTabState, Tab, TabGroup, TerminalTab } from '../../../../shared/types';
export type GroupEditorItem = OpenFile & {
    tabId: string;
};
export type GroupBrowserItem = BrowserTabState & {
    tabId: string;
};
type TerminalTabItem = {
    id: string;
    unifiedTabId: string;
    ptyId: null;
    worktreeId: string;
    title: string;
    customTitle: string | null;
    color: string | null;
    sortOrder: number;
    createdAt: number;
};
export declare function useTabGroupWorkspaceModel({ groupId, worktreeId }: {
    groupId: string;
    worktreeId: string;
}): {
    group: TabGroup | null;
    activeTab: Tab | null;
    activeBrowserTab: import("../../../../shared/types").BrowserWorkspace | null;
    browserItems: GroupBrowserItem[];
    editorItems: GroupEditorItem[];
    terminalTabs: TerminalTabItem[];
    tabBarOrder: string[];
    groupTabs: Tab[];
    worktreePath: string | undefined;
    runtimeTerminalTabById: Map<string, TerminalTab>;
    expandedPaneByTabId: Record<string, boolean>;
    commands: {
        focusGroup: () => void;
        activateBrowser: (browserTabId: string) => void;
        activateEditor: (tabId: string) => void;
        activateTerminal: (terminalId: string) => void;
        closeAllEditorTabsInGroup: () => void;
        closeGroup: () => void;
        closeItem: (itemId: string, opts?: {
            skipEmptyCheck?: boolean;
        }) => void;
        closeOthers: (itemId: string) => void;
        closeToRight: (itemId: string) => void;
        consumeSuppressedPtyExit: (ptyId: string) => boolean;
        createSplitGroup: (direction: "left" | "right" | "up" | "down", sourceVisibleTabId?: string) => void;
        newBrowserTab: () => void;
        newFileTab: () => Promise<void>;
        newTerminalTab: () => void;
        pinFile: (fileId: string, tabId?: string) => void;
        setTabColor: (tabId: string, color: string | null) => void;
        setTabCustomTitle: (tabId: string, title: string | null) => void;
    };
};
export {};
