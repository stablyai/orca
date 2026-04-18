import type { UnifiedTerminalItem } from './useTerminalTabs';
type UseTerminalShortcutsParams = {
    activeWorktreeId: string | null;
    activeTabId: string | null;
    activeFileId: string | null;
    activeTabType: 'terminal' | 'editor';
    unifiedTabs: UnifiedTerminalItem[];
    hasDirtyFiles: boolean;
    onNewTab: () => void;
    onCloseTab: (tabId: string) => void;
    onCloseFile: (fileId: string) => void;
    onActivateTerminalTab: (tabId: string) => void;
    onActivateEditorTab: (fileId: string) => void;
};
export declare function useTerminalShortcuts({ activeWorktreeId, activeTabId, activeFileId, activeTabType, unifiedTabs, hasDirtyFiles, onNewTab, onCloseTab, onCloseFile, onActivateTerminalTab, onActivateEditorTab }: UseTerminalShortcutsParams): void;
export {};
