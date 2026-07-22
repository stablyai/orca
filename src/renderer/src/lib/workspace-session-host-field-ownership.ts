import type { WorkspaceSessionState } from '../../../shared/types'

export type WorkspaceSessionFieldOwnership =
  | 'global'
  | 'hostPrivate'
  | 'worktreeKeyed'
  | 'worktreeArray'
  | 'tabKeyed'
  | 'browserWorkspaceKeyed'
  | 'fileKeyed'
  | 'sleepingAgentKeyed'
  | 'paneKeyed'
  | 'surfaceTombstoneKeyed'

export const WORKSPACE_SESSION_FIELD_OWNERSHIP = {
  activeRepoId: 'global',
  activeWorktreeId: 'global',
  activeTabId: 'global',
  browserUrlHistory: 'global',
  // Why: SSH remains local-owned, so its connection identifiers stay in the local slice.
  activeConnectionIdsAtShutdown: 'global',
  tabsByWorktree: 'worktreeKeyed',
  openFilesByWorktree: 'worktreeKeyed',
  activeFileIdByWorktree: 'worktreeKeyed',
  activeBrowserTabIdByWorktree: 'worktreeKeyed',
  activeTabTypeByWorktree: 'worktreeKeyed',
  activeTabIdByWorktree: 'worktreeKeyed',
  browserTabsByWorktree: 'worktreeKeyed',
  unifiedTabs: 'worktreeKeyed',
  tabGroups: 'worktreeKeyed',
  tabGroupLayouts: 'worktreeKeyed',
  activeGroupIdByWorktree: 'worktreeKeyed',
  lastVisitedAtByWorktreeId: 'worktreeKeyed',
  defaultTerminalTabsAppliedByWorktreeId: 'worktreeKeyed',
  activeWorkspaceKey: 'global',
  activeWorktreeIdsOnShutdown: 'worktreeArray',
  terminalLayoutsByTabId: 'tabKeyed',
  remoteSessionIdsByTabId: 'tabKeyed',
  browserPagesByWorkspace: 'browserWorkspaceKeyed',
  markdownFrontmatterVisible: 'fileKeyed',
  sleepingAgentSessionsByPaneKey: 'sleepingAgentKeyed',
  terminalPtyIncarnationsByPaneKey: 'paneKeyed',
  // Why: this host-issued fence must never collide while unified renderer state merges equal repo ids across hosts.
  terminalTopologyRevisionByRepoId: 'hostPrivate',
  terminalSurfaceTombstonesByPaneKey: 'surfaceTombstoneKeyed'
} as const satisfies Record<keyof WorkspaceSessionState, WorkspaceSessionFieldOwnership>

// Why: an unclassified persisted field would otherwise disappear from every non-local host.
type MissingOwnership = Exclude<
  keyof WorkspaceSessionState,
  keyof typeof WORKSPACE_SESSION_FIELD_OWNERSHIP
>
const exhaustive: [MissingOwnership] extends [never] ? true : never = true
void exhaustive

export const GLOBAL_WORKSPACE_SESSION_FIELDS = (
  Object.keys(WORKSPACE_SESSION_FIELD_OWNERSHIP) as (keyof WorkspaceSessionState)[]
).filter((field) => WORKSPACE_SESSION_FIELD_OWNERSHIP[field] === 'global')
