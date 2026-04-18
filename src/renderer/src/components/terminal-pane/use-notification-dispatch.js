import { useCallback } from 'react';
import { useAppStore } from '@/store';
/**
 * Returns a stable dispatch function for terminal notifications.
 * Reads repo/worktree labels from the store at dispatch time rather
 * than via selectors — avoids the allWorktrees() anti-pattern which
 * creates a new array reference on every store update and triggers
 * excessive re-renders of TerminalPane.
 */
export function useNotificationDispatch(worktreeId) {
    return useCallback((event) => {
        const state = useAppStore.getState();
        // Why: shutdownWorktreeTerminals clears ptyIdsByTabId synchronously
        // before killing PTYs asynchronously. Any notification arriving after
        // that point is stale — e.g. a staleTitleTimer that fires 3 s after
        // shutdown, or an agent tracker transition from accumulated closure
        // state. Checking for live PTYs at dispatch time catches ALL phantom
        // notification sources regardless of which timer or callback produced
        // them, rather than trying to cancel each one individually.
        const tabs = state.tabsByWorktree[worktreeId] ?? [];
        const hasLivePtys = tabs.some((tab) => (state.ptyIdsByTabId[tab.id] ?? []).length > 0);
        if (!hasLivePtys) {
            return;
        }
        const repoId = worktreeId.includes('::') ? worktreeId.slice(0, worktreeId.indexOf('::')) : '';
        const repo = state.repos.find((c) => c.id === repoId);
        const worktree = state.allWorktrees().find((c) => c.id === worktreeId);
        void window.api.notifications.dispatch({
            source: event.source,
            worktreeId,
            repoLabel: repo?.displayName,
            worktreeLabel: worktree?.displayName || worktree?.branch || worktreeId,
            terminalTitle: event.terminalTitle,
            isActiveWorktree: state.activeWorktreeId === worktreeId
        });
    }, [worktreeId]);
}
