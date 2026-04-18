import type { PaneManagerOptions, PaneStyleOptions, ManagedPane, DropZone } from './pane-manager-types';
export type { PaneManagerOptions, PaneStyleOptions, ManagedPane, DropZone };
export declare class PaneManager {
    private root;
    private panes;
    private activePaneId;
    private nextPaneId;
    private options;
    private styleOptions;
    private destroyed;
    private dragState;
    constructor(root: HTMLElement, options: PaneManagerOptions);
    createInitialPane(opts?: {
        focus?: boolean;
    }): ManagedPane;
    splitPane(paneId: number, direction: 'vertical' | 'horizontal', opts?: {
        ratio?: number;
    }): ManagedPane | null;
    closePane(paneId: number): void;
    getPanes(): ManagedPane[];
    getActivePane(): ManagedPane | null;
    setActivePane(paneId: number, opts?: {
        focus?: boolean;
    }): void;
    setPaneStyleOptions(opts: PaneStyleOptions): void;
    setPaneGpuRendering(paneId: number, enabled: boolean): void;
    /**
     * Suspend GPU rendering for all panes. Disposes WebGL addons to free
     * GPU contexts while keeping Terminal instances alive (scrollback, cursor,
     * screen buffer all preserved). Call when this tab/worktree becomes hidden.
     */
    suspendRendering(): void;
    /**
     * Resume GPU rendering for all panes. Recreates WebGL addons. Call when
     * this tab/worktree becomes visible again. Must be followed by a fit() pass.
     */
    resumeRendering(): void;
    /** Move a pane from its current position to a new position relative to a target pane. */
    movePane(sourcePaneId: number, targetPaneId: number, zone: DropZone): void;
    destroy(): void;
    private createPaneInternal;
    /**
     * Focus-follows-mouse entry point. Collects gate inputs from the manager
     * and delegates to the pure gate helper.
     *
     * Invariant for future contributors: modal overlays (context menus, close
     * dialogs, command palette) must be rendered as portals/siblings OUTSIDE
     * the pane container. If a future overlay is ever rendered inside a .pane
     * element, mouseenter will still fire on the pane underneath and this
     * handler will incorrectly switch focus. Keep overlays out of the pane.
     */
    private handlePaneMouseEnter;
    private createDividerWrapped;
    private applyDividerStylesWrapped;
    private toPublic;
    /** Build the callbacks object for drag-reorder functions. */
    private getDragCallbacks;
}
