import type React from 'react';
import type { RefObject } from 'react';
import type { TreeNode } from './file-explorer-types';
type UseFileExplorerHandlersParams = {
    activeWorktreeId: string | null;
    openFile: (params: {
        filePath: string;
        relativePath: string;
        worktreeId: string;
        language: string;
        mode: 'edit';
    }) => void;
    pinFile: (filePath: string) => void;
    toggleDir: (worktreeId: string, dirPath: string) => void;
    setSelectedPath: (path: string) => void;
    scrollRef: RefObject<HTMLDivElement | null>;
};
type UseFileExplorerHandlersReturn = {
    handleClick: (node: TreeNode) => void;
    handleDoubleClick: (node: TreeNode) => void;
    handleWheelCapture: (e: React.WheelEvent<HTMLDivElement>) => void;
};
export declare function useFileExplorerHandlers({ activeWorktreeId, openFile, pinFile, toggleDir, setSelectedPath, scrollRef }: UseFileExplorerHandlersParams): UseFileExplorerHandlersReturn;
export {};
