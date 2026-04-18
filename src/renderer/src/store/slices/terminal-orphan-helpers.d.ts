import type { AppState } from '../types';
type OrphanTerminalDetectionState = Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree' | 'ptyIdsByTabId'>;
type OrphanTerminalCleanupState = Pick<AppState, 'tabsByWorktree' | 'ptyIdsByTabId' | 'runtimePaneTitlesByTabId' | 'expandedPaneByTabId' | 'canExpandPaneByTabId' | 'terminalLayoutsByTabId' | 'pendingStartupByTabId' | 'pendingSetupSplitByTabId' | 'pendingIssueCommandSplitByTabId' | 'tabBarOrderByWorktree' | 'cacheTimerByKey' | 'activeTabIdByWorktree' | 'activeTabId'>;
export declare function getOrphanTerminalIds(state: OrphanTerminalDetectionState, worktreeId: string): Set<string>;
export declare function buildOrphanTerminalCleanupPatch(state: OrphanTerminalCleanupState, worktreeId: string, orphanTerminalIds: Set<string>): Pick<AppState, 'tabsByWorktree' | 'ptyIdsByTabId' | 'runtimePaneTitlesByTabId' | 'expandedPaneByTabId' | 'canExpandPaneByTabId' | 'terminalLayoutsByTabId' | 'pendingStartupByTabId' | 'pendingSetupSplitByTabId' | 'pendingIssueCommandSplitByTabId' | 'tabBarOrderByWorktree' | 'cacheTimerByKey' | 'activeTabIdByWorktree' | 'activeTabId'>;
export {};
