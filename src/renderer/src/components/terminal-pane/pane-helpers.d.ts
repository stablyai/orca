import type { PaneManager } from '@/lib/pane-manager/pane-manager';
export declare function fitPanes(manager: PaneManager): void;
/**
 * Returns true if any pane's proposed dimensions differ from its current
 * terminal cols/rows, meaning a fit() call would actually change layout.
 * Used by the epoch-based deduplication in use-terminal-pane-global-effects
 * to allow legitimate resize fits while suppressing redundant ones.
 */
export declare function hasDimensionsChanged(manager: PaneManager): boolean;
export declare function focusActivePane(manager: PaneManager): void;
export declare function fitAndFocusPanes(manager: PaneManager): void;
export declare function isWindowsUserAgent(userAgent?: string): boolean;
export declare function isMacUserAgent(userAgent?: string): boolean;
export declare function shellEscapePath(path: string, userAgent?: string): string;
