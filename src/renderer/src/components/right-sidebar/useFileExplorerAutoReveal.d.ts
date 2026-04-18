import type { Dispatch, SetStateAction } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import type { OpenFile } from '@/store/slices/editor';
import type { TreeNode } from './file-explorer-types';
type UseFileExplorerAutoRevealParams = {
    activeFileId: string | null;
    activeWorktreeId: string | null;
    worktreePath: string | null;
    pendingExplorerReveal: {
        worktreeId: string;
        filePath: string;
        requestId: number;
    } | null;
    openFiles: OpenFile[];
    rowsByPath: Map<string, TreeNode>;
    flatRows: TreeNode[];
    setSelectedPath: Dispatch<SetStateAction<string | null>>;
    virtualizer: Virtualizer<HTMLDivElement, Element>;
};
/**
 * Auto-reveal: when the active editor file changes, scroll the explorer to show it.
 * This mirrors VS Code's explorer.autoReveal behavior.
 *
 * For files already visible in the tree, scrolls directly (no flash).
 * For files whose ancestors are collapsed, triggers the reveal machinery
 * to expand ancestors and scroll, but skips the flash animation.
 */
export declare function useFileExplorerAutoReveal({ activeFileId, activeWorktreeId, worktreePath, pendingExplorerReveal, openFiles, rowsByPath, flatRows, setSelectedPath, virtualizer }: UseFileExplorerAutoRevealParams): void;
export {};
