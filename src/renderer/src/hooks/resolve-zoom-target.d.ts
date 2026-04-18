/**
 * Determine which zoom domain (terminal, editor, or UI) should be adjusted
 * based on current view, tab type, and focused element.
 */
export declare function resolveZoomTarget(args: {
    activeView: 'terminal' | 'settings' | 'new-workspace';
    activeTabType: 'terminal' | 'editor' | 'browser';
    activeElement: unknown;
}): 'terminal' | 'editor' | 'ui';
