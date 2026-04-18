import type { Repo, Worktree } from '../../../shared/types';
export type MatchRange = {
    start: number;
    end: number;
};
export type PaletteMatchedField = 'displayName' | 'branch' | 'repo' | 'comment' | 'pr' | 'issue';
export type PaletteSupportingText = {
    label: 'Comment' | 'PR' | 'Issue';
    text: string;
    matchRange: MatchRange | null;
};
export type PaletteSearchResult = {
    worktreeId: string;
    matchedField: PaletteMatchedField | null;
    displayNameRange: MatchRange | null;
    branchRange: MatchRange | null;
    repoRange: MatchRange | null;
    supportingText: PaletteSupportingText | null;
};
type PRCacheEntry = {
    data?: {
        number: number;
        title: string;
    } | null;
} | undefined;
type IssueCacheEntry = {
    data?: {
        number: number;
        title: string;
    } | null;
} | undefined;
export declare function searchWorktrees(worktrees: Worktree[], query: string, repoMap: Map<string, Repo>, prCache: Record<string, PRCacheEntry> | null, issueCache: Record<string, IssueCacheEntry> | null): PaletteSearchResult[];
export {};
