import type React from 'react';
import type { InlineInput } from './FileExplorerRow';
import type { TreeNode } from './file-explorer-types';
/**
 * Keyboard shortcuts for the file explorer.
 *
 * All shortcuts (bare-key and modifier) only fire when focus is inside
 * the explorer container — they must never intercept the editor or terminal.
 */
export declare function useFileExplorerKeys(opts: {
    containerRef: React.RefObject<HTMLDivElement | null>;
    flatRows: TreeNode[];
    inlineInput: InlineInput | null;
    selectedNode: TreeNode | null;
    startRename: (node: TreeNode) => void;
    requestDelete: (node: TreeNode) => void;
}): void;
