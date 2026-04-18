import type { StateCreator } from 'zustand';
import type { AppState } from '../types';
import type { DiffComment } from '../../../../shared/types';
export type DiffCommentsSlice = {
    getDiffComments: (worktreeId: string, filePath?: string) => DiffComment[];
    addDiffComment: (input: Omit<DiffComment, 'id' | 'createdAt'>) => Promise<DiffComment | null>;
    deleteDiffComment: (worktreeId: string, commentId: string) => Promise<void>;
    clearDiffComments: (worktreeId: string) => Promise<void>;
};
export declare const createDiffCommentsSlice: StateCreator<AppState, [], [], DiffCommentsSlice>;
