import { create } from 'zustand';
import { createRepoSlice } from './slices/repos';
import { createWorktreeSlice } from './slices/worktrees';
import { createTerminalSlice } from './slices/terminals';
import { createTabsSlice } from './slices/tabs';
import { createUISlice } from './slices/ui';
import { createSettingsSlice } from './slices/settings';
import { createGitHubSlice } from './slices/github';
import { createEditorSlice } from './slices/editor';
import { createStatsSlice } from './slices/stats';
import { createClaudeUsageSlice } from './slices/claude-usage';
import { createCodexUsageSlice } from './slices/codex-usage';
import { createBrowserSlice } from './slices/browser';
import { createRateLimitSlice } from './slices/rate-limits';
import { createSshSlice } from './slices/ssh';
import { createDiffCommentsSlice } from './slices/diffComments';
export const useAppStore = create()((...a) => ({
    ...createRepoSlice(...a),
    ...createWorktreeSlice(...a),
    ...createTerminalSlice(...a),
    ...createTabsSlice(...a),
    ...createUISlice(...a),
    ...createSettingsSlice(...a),
    ...createGitHubSlice(...a),
    ...createEditorSlice(...a),
    ...createStatsSlice(...a),
    ...createClaudeUsageSlice(...a),
    ...createCodexUsageSlice(...a),
    ...createBrowserSlice(...a),
    ...createRateLimitSlice(...a),
    ...createSshSlice(...a),
    ...createDiffCommentsSlice(...a)
}));
// DEV ONLY — exposes the store for console testing.
if (import.meta.env.DEV && typeof window !== 'undefined') {
    ;
    window.__store = useAppStore;
}
