import type { CreateWorktreeResult, SetupDecision, Worktree, WorktreeMeta } from '../../../../shared/types';
export type WorktreeDeleteState = {
    isDeleting: boolean;
    error: string | null;
    canForceDelete: boolean;
};
export type WorktreeSlice = {
    worktreesByRepo: Record<string, Worktree[]>;
    activeWorktreeId: string | null;
    deleteStateByWorktreeId: Record<string, WorktreeDeleteState>;
    /**
     * Monotonically increasing counter that signals when the sidebar sort order
     * should be recomputed.  Only bumped by events that represent meaningful
     * external changes (worktree add/remove, terminal activity, backend refresh)
     * — NOT by selection-triggered side-effects like clearing `isUnread`.
     */
    sortEpoch: number;
    fetchWorktrees: (repoId: string) => Promise<void>;
    fetchAllWorktrees: () => Promise<void>;
    createWorktree: (repoId: string, name: string, baseBranch?: string, setupDecision?: SetupDecision) => Promise<CreateWorktreeResult>;
    removeWorktree: (worktreeId: string, force?: boolean) => Promise<{
        ok: true;
    } | {
        ok: false;
        error: string;
    }>;
    clearWorktreeDeleteState: (worktreeId: string) => void;
    updateWorktreeMeta: (worktreeId: string, updates: Partial<WorktreeMeta>) => Promise<void>;
    markWorktreeUnread: (worktreeId: string) => void;
    bumpWorktreeActivity: (worktreeId: string) => void;
    setActiveWorktree: (worktreeId: string | null) => void;
    allWorktrees: () => Worktree[];
};
export declare function findWorktreeById(worktreesByRepo: Record<string, Worktree[]>, worktreeId: string): Worktree | undefined;
export declare function applyWorktreeUpdates(worktreesByRepo: Record<string, Worktree[]>, worktreeId: string, updates: Partial<WorktreeMeta>): Record<string, Worktree[]>;
export declare function getRepoIdFromWorktreeId(worktreeId: string): string;
