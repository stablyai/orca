import type { IDisposable } from '@xterm/xterm';
import { PaneManager } from '@/lib/pane-manager/pane-manager';
import type { GlobalSettings, SetupSplitDirection, TerminalLayoutSnapshot } from '../../../../shared/types';
import type { PtyTransport } from './pty-transport';
type UseTerminalPaneLifecycleDeps = {
    tabId: string;
    worktreeId: string;
    cwd?: string;
    startup?: {
        command: string;
        env?: Record<string, string>;
    } | null;
    /** When present, the initial pane boots clean and a split pane is created
     *  (vertical or horizontal per the user setting) to run the setup command —
     *  keeping the main terminal interactive. */
    setupSplit?: {
        command: string;
        env?: Record<string, string>;
        direction: SetupSplitDirection;
    } | null;
    /** When present, a split pane is created to run the repo's configured
     *  issue-automation command with the linked issue number interpolated. */
    issueCommandSplit?: {
        command: string;
        env?: Record<string, string>;
    } | null;
    isActive: boolean;
    systemPrefersDark: boolean;
    settings: GlobalSettings | null | undefined;
    settingsRef: React.RefObject<GlobalSettings | null | undefined>;
    initialLayoutRef: React.RefObject<TerminalLayoutSnapshot>;
    managerRef: React.RefObject<PaneManager | null>;
    containerRef: React.RefObject<HTMLDivElement | null>;
    expandedStyleSnapshotRef: React.MutableRefObject<Map<HTMLElement, {
        display: string;
        flex: string;
    }>>;
    paneFontSizesRef: React.RefObject<Map<number, number>>;
    paneTransportsRef: React.RefObject<Map<number, PtyTransport>>;
    panePtyBindingsRef: React.RefObject<Map<number, IDisposable>>;
    pendingWritesRef: React.RefObject<Map<number, string>>;
    isActiveRef: React.RefObject<boolean>;
    isVisibleRef: React.RefObject<boolean>;
    onPtyExitRef: React.RefObject<(ptyId: string) => void>;
    onPtyErrorRef?: React.RefObject<(paneId: number, message: string) => void>;
    clearTabPtyId: (tabId: string, ptyId: string) => void;
    consumeSuppressedPtyExit: (ptyId: string) => boolean;
    updateTabTitle: (tabId: string, title: string) => void;
    setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void;
    clearRuntimePaneTitle: (tabId: string, paneId: number) => void;
    updateTabPtyId: (tabId: string, ptyId: string) => void;
    markWorktreeUnread: (worktreeId: string) => void;
    dispatchNotification: (event: {
        source: 'agent-task-complete' | 'terminal-bell';
        terminalTitle?: string;
    }) => void;
    setCacheTimerStartedAt: (key: string, ts: number | null) => void;
    syncPanePtyLayoutBinding: (paneId: number, ptyId: string | null) => void;
    setTabPaneExpanded: (tabId: string, expanded: boolean) => void;
    setTabCanExpandPane: (tabId: string, canExpand: boolean) => void;
    setExpandedPane: (paneId: number | null) => void;
    syncExpandedLayout: () => void;
    persistLayoutSnapshot: () => void;
    setPaneTitles: React.Dispatch<React.SetStateAction<Record<number, string>>>;
    paneTitlesRef: React.RefObject<Record<number, string>>;
    setRenamingPaneId: React.Dispatch<React.SetStateAction<number | null>>;
};
type SplitStartupPayload = {
    command: string;
    env?: Record<string, string>;
};
type SplitWithStartupDeps = {
    startup?: SplitStartupPayload | null;
};
/** Scopes `deps.startup` to a single call of `splitPane()`, clearing it in `finally` so later splits do not replay the payload. */
export declare function splitPaneWithOneShotStartup<TPane>(deps: SplitWithStartupDeps, startup: SplitStartupPayload, splitPane: () => TPane): TPane;
export declare function useTerminalPaneLifecycle({ tabId, worktreeId, cwd, startup, setupSplit, issueCommandSplit, isActive, systemPrefersDark, settings, settingsRef, initialLayoutRef, managerRef, containerRef, expandedStyleSnapshotRef, paneFontSizesRef, paneTransportsRef, panePtyBindingsRef, pendingWritesRef, isActiveRef, isVisibleRef, onPtyExitRef, onPtyErrorRef, clearTabPtyId, consumeSuppressedPtyExit, updateTabTitle, setRuntimePaneTitle, clearRuntimePaneTitle, updateTabPtyId, markWorktreeUnread, dispatchNotification, setCacheTimerStartedAt, syncPanePtyLayoutBinding, setTabPaneExpanded, setTabCanExpandPane, setExpandedPane, syncExpandedLayout, persistLayoutSnapshot, setPaneTitles, paneTitlesRef, setRenamingPaneId }: UseTerminalPaneLifecycleDeps): void;
export {};
