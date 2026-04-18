import type { StateCreator } from 'zustand';
import type { AppState } from '../types';
import type { SetupSplitDirection, TerminalLayoutSnapshot, TerminalTab, WorkspaceSessionState } from '../../../../shared/types';
export type TerminalSlice = {
    tabsByWorktree: Record<string, TerminalTab[]>;
    activeTabId: string | null;
    /** Per-worktree last-active terminal tab — restored on worktree switch so
     *  the user returns to the same tab they left, not always tabs[0]. */
    activeTabIdByWorktree: Record<string, string | null>;
    ptyIdsByTabId: Record<string, string[]>;
    /** Live pane titles keyed by tabId then paneId. Unlike the legacy tab title,
     *  this preserves split-pane agent status per pane while TerminalPane is mounted. */
    runtimePaneTitlesByTabId: Record<string, Record<number, string>>;
    suppressedPtyExitIds: Record<string, true>;
    pendingCodexPaneRestartIds: Record<string, true>;
    codexRestartNoticeByPtyId: Record<string, {
        previousAccountLabel: string;
        nextAccountLabel: string;
    }>;
    expandedPaneByTabId: Record<string, boolean>;
    canExpandPaneByTabId: Record<string, boolean>;
    terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>;
    pendingStartupByTabId: Record<string, {
        command: string;
        env?: Record<string, string>;
    }>;
    /** Queued setup-split requests — when present, TerminalPane creates the
     *  initial pane clean, then splits (vertical or horizontal per user setting)
     *  and runs the command in the new pane so the main terminal stays
     *  immediately interactive. */
    pendingSetupSplitByTabId: Record<string, {
        command: string;
        env?: Record<string, string>;
        direction: SetupSplitDirection;
    }>;
    /** Queued issue-command-split requests — similar to setup splits but triggered
     *  when an issue is linked during worktree creation and the repo's issue
     *  automation command is enabled. */
    pendingIssueCommandSplitByTabId: Record<string, {
        command: string;
        env?: Record<string, string>;
    }>;
    tabBarOrderByWorktree: Record<string, string[]>;
    workspaceSessionReady: boolean;
    pendingReconnectWorktreeIds: string[];
    pendingReconnectTabByWorktree: Record<string, string[]>;
    /** Maps tabId → previous ptyId from the last session. When the PTY backend is
     *  a daemon, the old ptyId doubles as the daemon sessionId — passing it to
     *  spawn triggers createOrAttach which returns the surviving terminal snapshot. */
    pendingReconnectPtyIdByTabId: Record<string, string>;
    /** ANSI snapshots returned by daemon reattach, keyed by the new ptyId.
     *  TerminalPane writes these to xterm.js to restore visual state. */
    pendingSnapshotByPtyId: Record<string, {
        snapshot: string;
        cols?: number;
        rows?: number;
        isAlternateScreen?: boolean;
    }>;
    consumePendingSnapshot: (ptyId: string) => {
        snapshot: string;
        cols?: number;
        rows?: number;
        isAlternateScreen?: boolean;
    } | null;
    /** Cold restore data from disk history after a daemon crash, keyed by
     *  the new ptyId. Contains read-only scrollback to display above the
     *  fresh shell prompt. */
    pendingColdRestoreByPtyId: Record<string, {
        scrollback: string;
        cwd: string;
    }>;
    consumePendingColdRestore: (ptyId: string) => {
        scrollback: string;
        cwd: string;
    } | null;
    createTab: (worktreeId: string, targetGroupId?: string) => TerminalTab;
    closeTab: (tabId: string) => void;
    reorderTabs: (worktreeId: string, tabIds: string[]) => void;
    setTabBarOrder: (worktreeId: string, order: string[]) => void;
    setActiveTab: (tabId: string) => void;
    updateTabTitle: (tabId: string, title: string) => void;
    setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void;
    clearRuntimePaneTitle: (tabId: string, paneId: number) => void;
    setTabCustomTitle: (tabId: string, title: string | null) => void;
    setTabColor: (tabId: string, color: string | null) => void;
    updateTabPtyId: (tabId: string, ptyId: string) => void;
    clearTabPtyId: (tabId: string, ptyId?: string) => void;
    shutdownWorktreeTerminals: (worktreeId: string) => Promise<void>;
    suppressPtyExit: (ptyId: string) => void;
    consumeSuppressedPtyExit: (ptyId: string) => boolean;
    queueCodexPaneRestarts: (ptyIds: string[]) => void;
    consumePendingCodexPaneRestart: (ptyId: string) => boolean;
    markCodexRestartNotices: (notices: {
        ptyId: string;
        previousAccountLabel: string;
        nextAccountLabel: string;
    }[]) => void;
    clearCodexRestartNotice: (ptyId: string) => void;
    setTabPaneExpanded: (tabId: string, expanded: boolean) => void;
    setTabCanExpandPane: (tabId: string, canExpand: boolean) => void;
    setTabLayout: (tabId: string, layout: TerminalLayoutSnapshot | null) => void;
    queueTabStartupCommand: (tabId: string, startup: {
        command: string;
        env?: Record<string, string>;
    }) => void;
    consumeTabStartupCommand: (tabId: string) => {
        command: string;
        env?: Record<string, string>;
    } | null;
    queueTabSetupSplit: (tabId: string, startup: {
        command: string;
        env?: Record<string, string>;
        direction: SetupSplitDirection;
    }) => void;
    consumeTabSetupSplit: (tabId: string) => {
        command: string;
        env?: Record<string, string>;
        direction: SetupSplitDirection;
    } | null;
    queueTabIssueCommandSplit: (tabId: string, issueCommand: {
        command: string;
        env?: Record<string, string>;
    }) => void;
    consumeTabIssueCommandSplit: (tabId: string) => {
        command: string;
        env?: Record<string, string>;
    } | null;
    /** Per-pane timestamp (ms) when the prompt-cache countdown started (agent became idle).
     *  Keys are `${tabId}:${paneId}` composites so split-pane tabs can track each pane
     *  independently. null means no active timer for that pane. */
    cacheTimerByKey: Record<string, number | null>;
    setCacheTimerStartedAt: (key: string, ts: number | null) => void;
    /** Scan all tabs and seed cache timers for any idle Claude sessions that don't
     *  already have a timer. Called when the feature is enabled mid-session. */
    seedCacheTimersForIdleTabs: () => void;
    hydrateWorkspaceSession: (session: WorkspaceSessionState) => void;
    reconnectPersistedTerminals: (signal?: AbortSignal) => Promise<void>;
};
export declare const createTerminalSlice: StateCreator<AppState, [], [], TerminalSlice>;
