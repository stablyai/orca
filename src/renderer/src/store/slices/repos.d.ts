import type { StateCreator } from 'zustand';
import type { AppState } from '../types';
import type { Repo } from '../../../../shared/types';
export type RepoSlice = {
    repos: Repo[];
    activeRepoId: string | null;
    fetchRepos: () => Promise<void>;
    addRepo: () => Promise<Repo | null>;
    addNonGitFolder: (path: string) => Promise<Repo | null>;
    removeRepo: (repoId: string) => Promise<void>;
    updateRepo: (repoId: string, updates: Partial<Pick<Repo, 'displayName' | 'badgeColor' | 'hookSettings' | 'worktreeBaseRef' | 'kind'>>) => Promise<void>;
    setActiveRepo: (repoId: string | null) => void;
};
export declare const createRepoSlice: StateCreator<AppState, [], [], RepoSlice>;
