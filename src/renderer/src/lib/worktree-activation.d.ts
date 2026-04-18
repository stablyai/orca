import type { SetupSplitDirection, WorktreeSetupLaunch } from '../../../shared/types';
export type IssueCommandLaunch = WorktreeSetupLaunch | {
    command: string;
    env?: Record<string, string>;
};
type WorktreeActivationStore = {
    tabsByWorktree: Record<string, {
        id: string;
    }[]>;
    createTab: (worktreeId: string) => {
        id: string;
    };
    setActiveTab: (tabId: string) => void;
    setTabCustomTitle: (tabId: string, title: string | null) => void;
    reconcileWorktreeTabModel: (worktreeId: string) => {
        renderableTabCount: number;
    };
    queueTabStartupCommand: (tabId: string, startup: {
        command: string;
        env?: Record<string, string>;
    }) => void;
    queueTabSetupSplit: (tabId: string, startup: {
        command: string;
        env?: Record<string, string>;
        direction: SetupSplitDirection;
    }) => void;
    queueTabIssueCommandSplit: (tabId: string, startup: {
        command: string;
        env?: Record<string, string>;
    }) => void;
};
/**
 * Shared activation sequence used by the worktree palette, AddRepoDialog,
 * and AddWorktreeDialog. Covers: cross-repo `activeRepoId` switch,
 * `activeView` back to terminal, `setActiveWorktree`, initial terminal
 * creation, sidebar filter clearing, and sidebar reveal.
 *
 * The caller only passes `worktreeId`; the helper derives `repoId`
 * internally via `findWorktreeById`. Returns early without side effects
 * if the worktree is not found (e.g. deleted between palette open and select).
 */
export declare function activateAndRevealWorktree(worktreeId: string, opts?: {
    startup?: {
        command: string;
        env?: Record<string, string>;
    };
    setup?: WorktreeSetupLaunch;
    issueCommand?: IssueCommandLaunch;
}): boolean;
export declare function ensureWorktreeHasInitialTerminal(store: WorktreeActivationStore, worktreeId: string, startup?: {
    command: string;
    env?: Record<string, string>;
}, setup?: WorktreeSetupLaunch, issueCommand?: IssueCommandLaunch): void;
export {};
