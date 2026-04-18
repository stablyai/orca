import type { Worktree } from '../../../../shared/types';
/**
 * Resolves the on-disk path for the currently active worktree.
 */
export declare function useActiveWorktreePath(activeWorktreeId: string | null, worktreesByRepo: Record<string, Worktree[]>): string | null;
