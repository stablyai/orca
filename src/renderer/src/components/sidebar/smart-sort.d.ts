import type { Worktree, Repo, TerminalTab } from '../../../../shared/types';
type SortBy = 'name' | 'smart' | 'recent' | 'repo';
type PRCacheEntry = {
    data: object | null;
    fetchedAt: number;
};
export type SmartSortOverride = {
    worktree: Worktree;
    tabs: TerminalTab[];
    hasRecentPRSignal: boolean;
};
export declare function hasRecentPRSignal(worktree: Worktree, repoMap: Map<string, Repo>, prCache: Record<string, PRCacheEntry> | null): boolean;
/**
 * Build a comparator for sorting worktrees based on the current sort mode.
 */
export declare function buildWorktreeComparator(sortBy: SortBy, tabsByWorktree: Record<string, TerminalTab[]> | null, repoMap: Map<string, Repo>, prCache: Record<string, PRCacheEntry> | null, now?: number, smartSortOverrides?: Record<string, SmartSortOverride> | null): (a: Worktree, b: Worktree) => number;
/**
 * Sort worktrees by weighted smart-score signals, handling the cold-start /
 * warm distinction in one place. On cold start (no live PTYs yet), falls back
 * to persisted `sortOrder` descending with alphabetical `displayName` fallback.
 * Once any PTY is alive, uses the full smart-score comparator.
 *
 * Both the palette and `getVisibleWorktreeIds()` import this to avoid
 * duplicating the cold/warm branching logic.
 */
export declare function sortWorktreesSmart(worktrees: Worktree[], tabsByWorktree: Record<string, TerminalTab[]>, repoMap: Map<string, Repo>, prCache: Record<string, PRCacheEntry> | null): Worktree[];
/**
 * Compute a recent-work score for a worktree.
 * Higher score = higher in the list.
 *
 * Scoring:
 *   running AI job    → +60
 *   recent activity   → +36 (decays over 24 hours)
 *   needs attention   → +35
 *   unread            → +18
 *   open terminal     → +12
 *   live branch PR    → +10
 *   linked issue      → +6
 */
export declare function computeSmartScore(worktree: Worktree, tabsByWorktree: Record<string, TerminalTab[]> | null, repoMap: Map<string, Repo> | null, prCache: Record<string, PRCacheEntry> | null, now?: number): number;
export {};
