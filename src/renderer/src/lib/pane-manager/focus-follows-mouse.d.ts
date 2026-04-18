/**
 * Pure decision logic for the focus-follows-mouse feature. Kept free of
 * DOM/event dependencies so it can be unit-tested under vitest's node env.
 *
 * See docs/focus-follows-mouse-design.md for rationale behind each gate.
 */
export type FocusFollowsMouseInput = {
    featureEnabled: boolean;
    activePaneId: number | null;
    hoveredPaneId: number;
    mouseButtons: number;
    windowHasFocus: boolean;
    managerDestroyed: boolean;
};
/** Returns true iff the hovered pane should be activated. */
export declare function shouldFollowMouseFocus(input: FocusFollowsMouseInput): boolean;
