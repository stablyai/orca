import type { DropZone, ManagedPaneInternal, PaneStyleOptions } from './pane-manager-types';
type TreeOpsCallbacks = {
    getRoot: () => HTMLElement;
    getStyleOptions: () => PaneStyleOptions;
    safeFit: (pane: ManagedPaneInternal) => void;
    refitPanesUnder: (el: HTMLElement) => void;
    onLayoutChanged?: () => void;
};
export declare function safeFit(pane: ManagedPaneInternal): void;
export declare function refitPanesUnder(el: HTMLElement, panes: Map<number, ManagedPaneInternal>): void;
/**
 * Detach a pane's container from the split tree without disposing the terminal.
 * The sibling is promoted to take the split container's slot.
 */
export declare function detachPaneFromTree(pane: ManagedPaneInternal, callbacks: TreeOpsCallbacks): void;
/** Insert source pane next to target pane by wrapping target in a new split. */
export declare function insertPaneNextTo(source: ManagedPaneInternal, target: ManagedPaneInternal, zone: DropZone, callbacks: TreeOpsCallbacks): void;
/**
 * Promote a sibling element to replace its parent split container.
 * Used when a pane is removed and the split wrapper becomes unnecessary.
 */
export declare function promoteSibling(sibling: HTMLElement | null, parent: HTMLElement, root: HTMLElement): void;
/** Apply standard flex styles to a pane container inside a split. */
export declare function applyPaneFlexStyle(el: HTMLElement): void;
/** Remove all divider elements from a parent element. */
export declare function removeDividers(parent: HTMLElement): void;
/** Find non-divider children (panes and splits) of an element. */
export declare function findPaneChildren(parent: HTMLElement): HTMLElement[];
/**
 * Create a flex split wrapper that replaces `existingContainer` in the DOM,
 * then places [existing] [divider] [new] inside it.
 */
export declare function wrapInSplit(existingContainer: HTMLElement, newContainer: HTMLElement, isVertical: boolean, divider: HTMLElement, opts?: {
    ratio?: number;
}): void;
export {};
