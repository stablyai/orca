type WorktreePathLike = {
    path: string;
};
export declare function getSuggestedCreatureName(repoId: string, worktreesByRepo: Record<string, WorktreePathLike[]>, nestWorkspaces: boolean): string;
export declare function shouldApplySuggestedName(name: string, previousSuggestedName: string): boolean;
export declare function normalizeSuggestedName(name: string): string;
export {};
