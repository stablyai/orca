import type { RecoveryTerminalTab } from './cross-machine-recovery-descriptor'
import type { TerminalTab } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'

type RecoverySessionFieldPolicy = 'export' | 'drop' | 'global'

/** Every session field must be classified, so a new field cannot silently join or skip exports. */
export const RECOVERY_SESSION_FIELD_POLICY = {
  activeRepoId: 'global',
  activeWorkspaceKey: 'global',
  activeWorkspaceExecutionHostId: 'global',
  activeWorktreeId: 'global',
  activeTabId: 'global',
  tabsByWorktree: 'export',
  terminalLayoutsByTabId: 'export',
  localOnlyScrollbackByTabId: 'drop',
  activeWorktreeIdsOnShutdown: 'global',
  openFilesByWorktree: 'export',
  activeFileIdByWorktree: 'export',
  markdownFrontmatterVisible: 'drop',
  browserTabsByWorktree: 'export',
  browserPagesByWorkspace: 'export',
  activeBrowserTabIdByWorktree: 'export',
  clientHostedBrowserPagesByWorktree: 'drop',
  clientHostedBrowserCloseIntentsByEnvironment: 'drop',
  activeTabTypeByWorktree: 'export',
  browserUrlHistory: 'global',
  workspaceDocHistory: 'global',
  activeTabIdByWorktree: 'export',
  unifiedTabs: 'export',
  tabGroups: 'export',
  tabGroupLayouts: 'export',
  activeGroupIdByWorktree: 'export',
  activeConnectionIdsAtShutdown: 'global',
  remoteSessionIdsByTabId: 'drop',
  lastVisitedAtByWorktreeId: 'drop',
  defaultTerminalTabsAppliedByWorktreeId: 'drop',
  recoveryImportKeyByWorktreeId: 'drop',
  sleepingAgentSessionsByPaneKey: 'export',
  terminalPtyIncarnationsByPaneKey: 'drop',
  terminalTopologyRevisionByRepoId: 'drop',
  terminalSurfaceTombstonesByPaneKey: 'drop',
  closedTerminalTabTombstonesByTabId: 'drop'
} as const satisfies Record<keyof WorkspaceSessionState, RecoverySessionFieldPolicy>

/** Strips PTY incarnations, spawn/heal ledgers and host-only launch overrides from a terminal tab. */
export function sanitizeTerminalTabForRecovery(tab: TerminalTab): RecoveryTerminalTab {
  const {
    worktreeId: _worktreeId,
    ptyId: _ptyId,
    generation: _generation,
    pendingActivationSpawn: _pendingActivationSpawn,
    recovery: _recovery,
    forceHostRuntime: _forceHostRuntime,
    shellOverride: _shellOverride,
    ...rest
  } = tab
  void _worktreeId
  void _ptyId
  void _generation
  void _pendingActivationSpawn
  void _recovery
  void _forceHostRuntime
  void _shellOverride
  return rest
}
