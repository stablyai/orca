import type { WorkspaceSessionState } from './workspace-session-state-types'

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
  activeWorkspaceExecutionHostId: 'global',
  activeTabId: 'global',
  browserUrlHistory: 'global',
  workspaceDocHistory: 'global',
  // Client shutdown/reconnect obligations are global, independent of workspace ownership.
  activeConnectionIdsAtShutdown: 'global',
  clientHostedBrowserCloseIntentsByEnvironment: 'global',
  pairedTerminalTabCloseIntentsByEnvironment: 'global',
  tabsByWorktree: 'worktreeKeyed',
  openFilesByWorktree: 'worktreeKeyed',
  activeFileIdByWorktree: 'worktreeKeyed',
  activeBrowserTabIdByWorktree: 'worktreeKeyed',
  activeTabTypeByWorktree: 'worktreeKeyed',
  activeTabIdByWorktree: 'worktreeKeyed',
  browserTabsByWorktree: 'worktreeKeyed',
  // Runtime-authored rows still need owner routing on merged reads, even though the renderer never writes them.
  clientHostedBrowserPagesByWorktree: 'worktreeKeyed',
  unifiedTabs: 'worktreeKeyed',
  tabGroups: 'worktreeKeyed',
  tabGroupLayouts: 'worktreeKeyed',
  activeGroupIdByWorktree: 'worktreeKeyed',
  lastVisitedAtByWorktreeId: 'worktreeKeyed',
  defaultTerminalTabsAppliedByWorktreeId: 'worktreeKeyed',
  activeWorkspaceKey: 'global',
  activeWorktreeIdsOnShutdown: 'worktreeArray',
  terminalLayoutsByTabId: 'tabKeyed',
  // Local-only scrollback never uploads but follows its tab’s host partition; do not merge it across hosts like sleeping-agent rows.
  localOnlyScrollbackByTabId: 'tabKeyed',
  remoteSessionIdsByTabId: 'tabKeyed',
  browserPagesByWorkspace: 'browserWorkspaceKeyed',
  markdownFrontmatterVisible: 'fileKeyed',
  sleepingAgentSessionsByPaneKey: 'sleepingAgentKeyed',
  terminalPtyIncarnationsByPaneKey: 'paneKeyed',
  // Why: this host-issued fence must never collide while unified renderer state merges equal repo ids across hosts.
  terminalTopologyRevisionByRepoId: 'hostPrivate',
  terminalSurfaceTombstonesByPaneKey: 'surfaceTombstoneKeyed',
  // Closed tabs no longer appear in worktreeIdByTabId; route tombstones by their recorded workspace, as for closed panes.
  closedTerminalTabTombstonesByTabId: 'surfaceTombstoneKeyed',
  closedTerminalPanesByPaneKey: 'surfaceTombstoneKeyed'
} as const satisfies Record<keyof WorkspaceSessionState, WorkspaceSessionFieldOwnership>

// Why: an unclassified persisted field would otherwise disappear from every non-local host.
type MissingOwnership = Exclude<
  keyof WorkspaceSessionState,
  keyof typeof WORKSPACE_SESSION_FIELD_OWNERSHIP
>
const exhaustive: [MissingOwnership] extends [never] ? true : never = true
void exhaustive

export const SESSION_FOCUS_FIELDS = [
  'activeRepoId',
  'activeWorktreeId',
  'activeWorkspaceKey',
  'activeWorkspaceExecutionHostId',
  'activeTabId'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

export const GLOBAL_WORKSPACE_SESSION_FIELDS = (
  Object.keys(WORKSPACE_SESSION_FIELD_OWNERSHIP) as (keyof WorkspaceSessionState)[]
).filter((field) => WORKSPACE_SESSION_FIELD_OWNERSHIP[field] === 'global')

/** These globals are read from local only; redundant non-local copies waste every save/load.
 * Keep focus/workspace references used to establish ownership and fields with main-side partition readers (activeTabId, activeConnectionIdsAtShutdown, activeRepoId). The partition tests verify both exclusions. */
export const HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS = [
  'browserUrlHistory',
  'workspaceDocHistory'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

/** Sweep non-local slices on serialization because default spreading reintroduces these fields on load. Return the input if nothing drops. */
export function withoutRedundantPartitionGlobals<
  T extends Partial<Record<string, WorkspaceSessionState>>
>(partitions: T, local: Partial<WorkspaceSessionState> | undefined): T {
  let pruned: Record<string, WorkspaceSessionState | undefined> | undefined
  for (const [hostId, slice] of Object.entries(partitions) as [
    string,
    WorkspaceSessionState | undefined
  ][]) {
    if (!slice) {
      continue
    }
    const next = withoutRedundantGlobalFields(slice, local)
    if (next === slice) {
      continue
    }
    pruned ||= { ...partitions }
    pruned[hostId] = next
  }
  return (pruned as T | undefined) ?? partitions
}

export function hostPartitionSliceTemplate(template: WorkspaceSessionState): WorkspaceSessionState {
  return withoutRedundantGlobalFields(template, template)
}

/** Drop redundant globals only when local already holds them, preserving merge fallback. Return slice unchanged for a no-op. */
export function withoutRedundantGlobalFields<T extends Partial<WorkspaceSessionState>>(
  slice: T,
  local: Partial<WorkspaceSessionState> | undefined
): T {
  let pruned: T | undefined
  for (const field of HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS) {
    if (local?.[field] === undefined || !Object.hasOwn(slice, field)) {
      continue
    }
    pruned ??= { ...slice }
    delete pruned[field]
  }
  return pruned ?? slice
}
