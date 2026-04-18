import type { PaneManager } from '@/lib/pane-manager/pane-manager';
import type { PtyTransport } from './pty-transport';
import type { MacOptionAsAlt } from './terminal-shortcut-policy';
export type SearchState = {
    query: string;
    caseSensitive: boolean;
    regex: boolean;
};
/**
 * Pure decision function for Cmd+G / Cmd+Shift+G search navigation.
 * Returns 'next', 'previous', or null (no match).
 * Extracted so the key-matching logic is testable without DOM dependencies.
 */
export declare function matchSearchNavigate(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, isMac: boolean, searchOpen: boolean, searchState: SearchState): 'next' | 'previous' | null;
type KeyboardHandlersDeps = {
    isActive: boolean;
    managerRef: React.RefObject<PaneManager | null>;
    paneTransportsRef: React.RefObject<Map<number, PtyTransport>>;
    expandedPaneIdRef: React.RefObject<number | null>;
    setExpandedPane: (paneId: number | null) => void;
    restoreExpandedLayout: () => void;
    refreshPaneSizes: (focusActive: boolean) => void;
    persistLayoutSnapshot: () => void;
    toggleExpandPane: (paneId: number) => void;
    setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
    onRequestClosePane: (paneId: number) => void;
    searchOpenRef: React.RefObject<boolean>;
    searchStateRef: React.RefObject<SearchState>;
    macOptionAsAltRef: React.RefObject<MacOptionAsAlt>;
};
export declare function useTerminalKeyboardShortcuts({ isActive, managerRef, paneTransportsRef, expandedPaneIdRef, setExpandedPane, restoreExpandedLayout, refreshPaneSizes, persistLayoutSnapshot, toggleExpandPane, setSearchOpen, onRequestClosePane, searchOpenRef, searchStateRef, macOptionAsAltRef }: KeyboardHandlersDeps): void;
export {};
