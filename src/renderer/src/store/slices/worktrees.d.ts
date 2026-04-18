import type { StateCreator } from 'zustand';
import type { AppState } from '../types';
import { type WorktreeSlice } from './worktree-helpers';
export type { WorktreeSlice, WorktreeDeleteState } from './worktree-helpers';
export declare const createWorktreeSlice: StateCreator<AppState, [], [], WorktreeSlice>;
