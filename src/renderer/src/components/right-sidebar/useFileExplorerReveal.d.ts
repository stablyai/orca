import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import type { DirCache, TreeNode } from './file-explorer-types';
type UseFileExplorerRevealParams = {
    activeWorktreeId: string | null;
    worktreePath: string | null;
    pendingExplorerReveal: {
        worktreeId: string;
        filePath: string;
        requestId: number;
        flash?: boolean;
    } | null;
    clearPendingExplorerReveal: () => void;
    expanded: Set<string>;
    dirCache: Record<string, DirCache>;
    rootCache: DirCache | undefined;
    rowsByPath: Map<string, TreeNode>;
    flatRows: TreeNode[];
    loadDir: (dirPath: string, depth: number, options?: {
        force?: boolean;
    }) => Promise<void>;
    setSelectedPath: Dispatch<SetStateAction<string | null>>;
    setFlashingPath: Dispatch<SetStateAction<string | null>>;
    flashTimeoutRef: RefObject<number | null>;
    virtualizer: Virtualizer<HTMLDivElement, Element>;
};
export declare function useFileExplorerReveal({ activeWorktreeId, worktreePath, pendingExplorerReveal, clearPendingExplorerReveal, expanded, dirCache, rootCache, rowsByPath, flatRows, loadDir, setSelectedPath, setFlashingPath, flashTimeoutRef, virtualizer }: UseFileExplorerRevealParams): void;
export {};
