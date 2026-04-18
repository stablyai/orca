import type React from 'react';
import type { DirCache, TreeNode } from './file-explorer-types';
type UseFileExplorerTreeResult = {
    dirCache: Record<string, DirCache>;
    setDirCache: React.Dispatch<React.SetStateAction<Record<string, DirCache>>>;
    flatRows: TreeNode[];
    rowsByPath: Map<string, TreeNode>;
    rootCache: DirCache | undefined;
    rootError: string | null;
    loadDir: (dirPath: string, depth: number, options?: {
        force?: boolean;
    }) => Promise<void>;
    refreshTree: () => Promise<void>;
    refreshDir: (dirPath: string) => Promise<void>;
    resetAndLoad: () => void;
};
export declare function useFileExplorerTree(worktreePath: string | null, expanded: Set<string>, activeWorktreeId?: string | null): UseFileExplorerTreeResult;
export {};
