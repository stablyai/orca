import type { PaneManager } from '@/lib/pane-manager/pane-manager';
type ExpandCollapseState = {
    expandedPaneIdRef: React.MutableRefObject<number | null>;
    expandedStyleSnapshotRef: React.MutableRefObject<Map<HTMLElement, {
        display: string;
        flex: string;
    }>>;
    containerRef: React.RefObject<HTMLDivElement | null>;
    managerRef: React.RefObject<PaneManager | null>;
    setExpandedPaneId: (paneId: number | null) => void;
    setTabPaneExpanded: (tabId: string, expanded: boolean) => void;
    tabId: string;
    persistLayoutSnapshot: () => void;
};
export declare function restoreExpandedLayoutFrom(snapshots: Map<HTMLElement, {
    display: string;
    flex: string;
}>): void;
export declare function applyExpandedLayoutTo(paneId: number, state: Pick<ExpandCollapseState, 'managerRef' | 'containerRef' | 'expandedStyleSnapshotRef'>): boolean;
export declare function createExpandCollapseActions(state: ExpandCollapseState): {
    setExpandedPane: (paneId: number | null) => void;
    restoreExpandedLayout: () => void;
    refreshPaneSizes: (focusActive: boolean) => void;
    syncExpandedLayout: () => void;
    toggleExpandPane: (paneId: number) => void;
};
export {};
