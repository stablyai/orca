import type { TreeNode } from './file-explorer-types';
type UseFileDuplicateParams = {
    worktreePath: string | null;
    refreshDir: (dirPath: string) => Promise<void>;
};
export declare function useFileDuplicate({ worktreePath, refreshDir }: UseFileDuplicateParams): (node: TreeNode) => void;
export {};
