import type React from 'react';
import type { InlineInput } from './FileExplorerRow';
import type { TreeNode } from './file-explorer-types';
type UseFileExplorerInlineInputParams = {
    activeWorktreeId: string | null;
    worktreePath: string | null;
    expanded: Set<string>;
    flatRows: TreeNode[];
    scrollRef: React.RefObject<HTMLDivElement | null>;
    refreshDir: (dirPath: string) => Promise<void>;
};
type UseFileExplorerInlineInputResult = {
    inlineInput: InlineInput | null;
    inlineInputIndex: number;
    startNew: (type: 'file' | 'folder', parentPath: string, depth: number) => void;
    startRename: (node: TreeNode) => void;
    dismissInlineInput: () => void;
    handleInlineSubmit: (value: string) => void;
};
export declare function useFileExplorerInlineInput({ activeWorktreeId, worktreePath, expanded, flatRows, scrollRef, refreshDir }: UseFileExplorerInlineInputParams): UseFileExplorerInlineInputResult;
export {};
