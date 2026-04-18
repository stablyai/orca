import type { PaneStyleOptions, ManagedPaneInternal } from './pane-manager-types';
/** Total hit area size = visible thickness + invisible padding on each side */
export declare function getDividerHitSize(styleOptions: PaneStyleOptions): number;
export declare function createDivider(isVertical: boolean, styleOptions: PaneStyleOptions, callbacks: {
    refitPanesUnder: (el: HTMLElement) => void;
    onLayoutChanged?: () => void;
}): HTMLElement;
export declare function applyDividerStyles(root: HTMLElement, styleOptions: PaneStyleOptions): void;
export declare function applyPaneOpacity(panes: Iterable<ManagedPaneInternal>, activePaneId: number | null, styleOptions: PaneStyleOptions): void;
export declare function applyRootBackground(root: HTMLElement, styleOptions: PaneStyleOptions): void;
