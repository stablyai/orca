import type { DropZone, ManagedPaneInternal } from './pane-manager-types';
import type { PaneStyleOptions } from './pane-manager-types';
export type DragReorderState = {
    dragSourcePaneId: number | null;
    dropOverlay: HTMLElement | null;
    currentDropTarget: {
        paneId: number;
        zone: DropZone;
    } | null;
};
export type DragReorderCallbacks = {
    getPanes: () => Map<number, ManagedPaneInternal>;
    getRoot: () => HTMLElement;
    getStyleOptions: () => PaneStyleOptions;
    isDestroyed: () => boolean;
    safeFit: (pane: ManagedPaneInternal) => void;
    applyPaneOpacity: () => void;
    applyDividerStyles: () => void;
    refitPanesUnder: (el: HTMLElement) => void;
    onLayoutChanged?: () => void;
};
export declare function createDragReorderState(): DragReorderState;
/** Attach drag-to-reorder handlers to a pane's drag handle. */
export declare function attachPaneDrag(handle: HTMLElement, paneId: number, state: DragReorderState, callbacks: DragReorderCallbacks): void;
/** Move a pane from its current position to a new position relative to a target pane. */
export declare function handlePaneDrop(sourcePaneId: number, targetPaneId: number, zone: DropZone, _state: DragReorderState, callbacks: DragReorderCallbacks): void;
export declare function showDropOverlay(state: DragReorderState): void;
export declare function hideDropOverlay(state: DragReorderState): void;
/** Add/remove .has-multiple-panes on root to control drag handle visibility. */
export declare function updateMultiPaneState(callbacks: DragReorderCallbacks): void;
