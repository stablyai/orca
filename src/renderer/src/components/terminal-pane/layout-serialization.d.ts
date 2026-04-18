import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../../../shared/types';
import type { PaneManager } from '@/lib/pane-manager/pane-manager';
export declare const EMPTY_LAYOUT: TerminalLayoutSnapshot;
export declare function paneLeafId(paneId: number): string;
export declare function collectLeafIdsInOrder(node: TerminalPaneLayoutNode | null | undefined): string[];
export declare function collectLeafIdsInReplayCreationOrder(node: TerminalPaneLayoutNode | null | undefined): string[];
export declare function buildFontFamily(fontFamily: string): string;
export declare function getLayoutChildNodes(split: HTMLElement): HTMLElement[];
export declare function serializePaneTree(node: HTMLElement | null): TerminalPaneLayoutNode | null;
export declare function serializeTerminalLayout(root: HTMLDivElement | null, activePaneId: number | null, expandedPaneId: number | null): TerminalLayoutSnapshot;
/**
 * Write saved scrollback buffers into the restored panes so the user sees
 * their previous terminal output after an app restart.  If a buffer was
 * captured while the alternate screen was active (e.g. an agent TUI was
 * running at shutdown), we exit alt-screen first so the user sees a usable
 * normal-mode terminal.
 */
export declare function restoreScrollbackBuffers(manager: PaneManager, savedBuffers: Record<string, string> | undefined, restoredPaneByLeafId: Map<string, number>): void;
export declare function replayTerminalLayout(manager: PaneManager, snapshot: TerminalLayoutSnapshot | null | undefined, focusInitialPane: boolean): Map<string, number>;
