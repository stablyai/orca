import type { Worktree, Repo, TerminalTab } from '../../../../shared/types';
import type { AppState } from '@/store/types';
/**
 * Shared pure utility that computes the ordered list of visible (non-archived,
 * non-filtered) worktree IDs. Both the App-level Cmd+1–9 handler and
 * WorktreeList's render pipeline consume this function so the numbering and
 * card order can never diverge.
 *
 * Why a shared function: if the filter/sort pipeline lived in two places, a
 * new filter added in one but not the other would silently break the mapping
 * between badge numbers and the Cmd+N shortcut target.
 */
export declare function computeVisibleWorktreeIds(worktreesByRepo: Record<string, Worktree[]>, sortedIds: string[], opts: {
    filterRepoIds: string[];
    searchQuery: string;
    showActiveOnly: boolean;
    tabsByWorktree: Record<string, TerminalTab[]> | null;
    browserTabsByWorktree?: Record<string, {
        id: string;
    }[]> | null;
    activeWorktreeId?: string | null;
    repoMap: Map<string, Repo>;
    prCache: AppState['prCache'] | null;
    issueCache: AppState['issueCache'] | null;
}): string[];
/**
 * Called by WorktreeList after computing visible worktrees so the Cmd+1–9
 * handler can read the exact same ordering the user sees on screen.
 */
export declare function setVisibleWorktreeIds(ids: string[]): void;
/**
 * Compute the visible worktree IDs on-demand from the current Zustand store
 * state. Called by the App-level Cmd+1–9 handler (not a React hook — reads
 * store snapshot at call time).
 *
 * If WorktreeList has rendered at least once, returns the cached IDs so the
 * shortcut numbering matches the sidebar. Falls back to a live recomputation
 * only before WorktreeList's first render (e.g. app startup).
 */
export declare function getVisibleWorktreeIds(): string[];
