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
  // Why: SSH remains local-owned, so its connection identifiers stay in the local slice.
  activeConnectionIdsAtShutdown: 'global',
  // Why global: keyed by runtime environment rather than by worktree, and it is this client's
  // record of what it owes those environments — the same reason SSH connection state stays local.
  clientHostedBrowserCloseIntentsByEnvironment: 'global',
  tabsByWorktree: 'worktreeKeyed',
  openFilesByWorktree: 'worktreeKeyed',
  activeFileIdByWorktree: 'worktreeKeyed',
  activeBrowserTabIdByWorktree: 'worktreeKeyed',
  activeTabTypeByWorktree: 'worktreeKeyed',
  activeTabIdByWorktree: 'worktreeKeyed',
  browserTabsByWorktree: 'worktreeKeyed',
  // Runtime-authored, never written by this renderer; classified so a merged read still routes each
  // worktree's rows back to the host that owns them instead of dropping them.
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
  remoteSessionIdsByTabId: 'tabKeyed',
  browserPagesByWorkspace: 'browserWorkspaceKeyed',
  markdownFrontmatterVisible: 'fileKeyed',
  sleepingAgentSessionsByPaneKey: 'sleepingAgentKeyed',
  terminalPtyIncarnationsByPaneKey: 'paneKeyed',
  // Why: this host-issued fence must never collide while unified renderer state merges equal repo ids across hosts.
  terminalTopologyRevisionByRepoId: 'hostPrivate',
  terminalSurfaceTombstonesByPaneKey: 'surfaceTombstoneKeyed',
  // Why not tabKeyed: the tab is already gone, so worktreeIdByTabId can never resolve it. Routing by
  // the record's own worktreeId is the same problem terminalSurfaceTombstonesByPaneKey has.
  closedTerminalTabTombstonesByTabId: 'surfaceTombstoneKeyed'
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

/**
 * Global session fields that belong to the 'local' slice alone: `splitWorkspaceSessionByHost`
 * writes them only there and `mergeWorkspaceSessionsFromHosts` reads them only from there. A copy
 * inside a non-local partition is residue no read can reach — stale `browserUrlHistory` replicas
 * alone were 589 KB, 12.7% of a 4.65 MB store, rewritten on every save and reparsed on every
 * launch.
 *
 * Deliberately NOT every field in `GLOBAL_WORKSPACE_SESSION_FIELDS`. Two separate gates disqualify
 * the rest, and both are load-bearing:
 *  - `activeWorktreeId` and `activeWorkspaceKey` are `'direct'` in
 *    `WORKSPACE_SESSION_WORKTREE_REFERENCE_KIND`, and both `collectPersistedSessionWorktreeOwners`
 *    and the deregistered-repo residue sweep read them out of EVERY partition. Dropping one
 *    un-owns a worktree, and an un-owned worktree gets its metadata pruned.
 *  - `activeTabId`, `activeConnectionIdsAtShutdown` and `activeRepoId` have live main-side readers
 *    on a partition: `isPersistedTerminalLeafActive` falls back to `activeTabId` for the mobile
 *    projection, and the runtime attach-window handoff unions `activeConnectionIdsAtShutdown`.
 *
 * `workspace-session-partitions.test.ts` re-checks both gates for every field listed here.
 */
export const HOST_PARTITION_REDUNDANT_GLOBAL_FIELDS = [
  'browserUrlHistory',
  'workspaceDocHistory'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

/** Serialize-side sweep over every non-local partition. The load path re-seeds these fields at
 *  their default from the session defaults spread, so a partition that holds only that default
 *  still costs bytes on every save; this is where those go. Returns the input when nothing drops. */
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

/** Non-local slice template: the same globals minus the ones only 'local' is ever read for. */
export function hostPartitionSliceTemplate(template: WorkspaceSessionState): WorkspaceSessionState {
  return withoutRedundantGlobalFields(template, template)
}

/** Drop redundant globals only where `local` already holds the field — exactly when the merge's
 *  fallback to another slice cannot fire. Returns `slice` untouched when nothing is dropped, so
 *  callers that rely on identity keep it. */
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
