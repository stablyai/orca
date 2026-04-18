import type { StateCreator } from 'zustand';
import type { AppState } from '../types';
import type { PRInfo, IssueInfo, PRCheckDetail, PRComment, GitHubWorkItem } from '../../../../shared/types';
export type CacheEntry<T> = {
    data: T | null;
    fetchedAt: number;
};
type FetchOptions = {
    force?: boolean;
};
export type GitHubSlice = {
    prCache: Record<string, CacheEntry<PRInfo>>;
    issueCache: Record<string, CacheEntry<IssueInfo>>;
    checksCache: Record<string, CacheEntry<PRCheckDetail[]>>;
    commentsCache: Record<string, CacheEntry<PRComment[]>>;
    workItemsCache: Record<string, CacheEntry<GitHubWorkItem[]>>;
    fetchPRForBranch: (repoPath: string, branch: string, options?: FetchOptions) => Promise<PRInfo | null>;
    fetchIssue: (repoPath: string, number: number) => Promise<IssueInfo | null>;
    fetchPRChecks: (repoPath: string, prNumber: number, branch?: string, headSha?: string, options?: FetchOptions) => Promise<PRCheckDetail[]>;
    fetchPRComments: (repoPath: string, prNumber: number, options?: FetchOptions) => Promise<PRComment[]>;
    resolveReviewThread: (repoPath: string, prNumber: number, threadId: string, resolve: boolean) => Promise<boolean>;
    initGitHubCache: () => Promise<void>;
    refreshAllGitHub: () => void;
    refreshGitHubForWorktree: (worktreeId: string) => void;
    refreshGitHubForWorktreeIfStale: (worktreeId: string) => void;
    /**
     * Why: returns cached work items immediately (null if none) and fires a
     * background refresh when stale. Callers can render the cached list while
     * the SWR revalidate hydrates the latest.
     */
    getCachedWorkItems: (repoPath: string, limit: number, query: string) => GitHubWorkItem[] | null;
    fetchWorkItems: (repoPath: string, limit: number, query: string, options?: FetchOptions) => Promise<GitHubWorkItem[]>;
    /**
     * Fire-and-forget prefetch used by UI entry points (hover/focus of the
     * "new workspace" buttons) to warm the cache before the page mounts.
     */
    prefetchWorkItems: (repoPath: string, limit?: number, query?: string) => void;
};
export declare const createGitHubSlice: StateCreator<AppState, [], [], GitHubSlice>;
export {};
