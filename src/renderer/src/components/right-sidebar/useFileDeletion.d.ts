import type { Dispatch, SetStateAction } from 'react';
import type { PendingDelete, TreeNode } from './file-explorer-types';
type UseFileDeletionParams = {
    activeWorktreeId: string | null;
    openFiles: {
        id: string;
        filePath: string;
    }[];
    closeFile: (fileId: string) => void;
    refreshDir: (dirPath: string) => Promise<void>;
    selectedPath: string | null;
    setSelectedPath: Dispatch<SetStateAction<string | null>>;
    isMac: boolean;
    isWindows: boolean;
};
type UseFileDeletionResult = {
    pendingDelete: PendingDelete | null;
    isDeleting: boolean;
    deleteShortcutLabel: string;
    deleteActionLabel: string;
    deleteDescription: string;
    requestDelete: (node: TreeNode) => void;
    closeDeleteDialog: () => void;
    confirmDelete: () => Promise<void>;
};
export declare function useFileDeletion({ activeWorktreeId, openFiles, closeFile, refreshDir, selectedPath, setSelectedPath, isMac, isWindows }: UseFileDeletionParams): UseFileDeletionResult;
export {};
