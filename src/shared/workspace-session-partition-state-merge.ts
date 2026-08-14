import type { WorkspaceSessionState } from './workspace-session-state-types'
import { repoIdForWorkspaceKey } from './workspace-session-partition-authority'
import {
  mergeBrowserHistory,
  mergeTopologyRevisions,
  mergeUnique,
  mergeWorkspaceRecord
} from './workspace-session-partition-provenance'

type PartitionStateMerge = {
  base: WorkspaceSessionState
  source: WorkspaceSessionState
  reconciledKeys: ReadonlySet<string>
  sourceAuthority: ReadonlySet<string>
  ambiguousWorktreeIds: ReadonlySet<string>
  tabsByWorktree: WorkspaceSessionState['tabsByWorktree']
  terminalLayoutsByTabId: WorkspaceSessionState['terminalLayoutsByTabId']
  remoteSessionIdsByTabId: NonNullable<WorkspaceSessionState['remoteSessionIdsByTabId']>
  sleepingAgentSessionsByPaneKey: NonNullable<
    WorkspaceSessionState['sleepingAgentSessionsByPaneKey']
  >
  terminalPtyIncarnationsByPaneKey: NonNullable<
    WorkspaceSessionState['terminalPtyIncarnationsByPaneKey']
  >
  terminalSurfaceTombstonesByPaneKey: NonNullable<
    WorkspaceSessionState['terminalSurfaceTombstonesByPaneKey']
  >
}

export function mergeAdoptedWorkspaceSessionState(
  input: PartitionStateMerge
): WorkspaceSessionState {
  const { base, source, reconciledKeys, sourceAuthority, ambiguousWorktreeIds } = input
  const browserPagesByWorkspace = { ...base.browserPagesByWorkspace }
  for (const [workspaceId, pages] of Object.entries(source.browserPagesByWorkspace ?? {})) {
    if (
      (browserPagesByWorkspace[workspaceId] === undefined &&
        pages.every((page) => reconciledKeys.has(page.worktreeId))) ||
      pages.some((page) => sourceAuthority.has(page.worktreeId))
    ) {
      browserPagesByWorkspace[workspaceId] = pages
    }
  }
  const mergeRecord = <T>(
    baseRecord: Record<string, T> | undefined,
    sourceRecord: Record<string, T> | undefined
  ) => mergeWorkspaceRecord(baseRecord, sourceRecord, reconciledKeys, sourceAuthority)

  return {
    ...source,
    ...base,
    activeRepoId:
      base.activeRepoId ?? (ambiguousWorktreeIds.size === 0 ? source.activeRepoId : null),
    activeWorkspaceKey:
      base.activeWorkspaceKey ??
      (ambiguousWorktreeIds.size === 0 ? source.activeWorkspaceKey : null),
    activeWorkspaceExecutionHostId:
      base.activeWorkspaceExecutionHostId ??
      (ambiguousWorktreeIds.size === 0 ? source.activeWorkspaceExecutionHostId : null),
    activeWorktreeId:
      base.activeWorktreeId ?? (ambiguousWorktreeIds.size === 0 ? source.activeWorktreeId : null),
    activeTabId: base.activeTabId ?? (ambiguousWorktreeIds.size === 0 ? source.activeTabId : null),
    tabsByWorktree: input.tabsByWorktree,
    terminalLayoutsByTabId: input.terminalLayoutsByTabId,
    openFilesByWorktree: mergeRecord(base.openFilesByWorktree, source.openFilesByWorktree),
    activeFileIdByWorktree: mergeRecord(base.activeFileIdByWorktree, source.activeFileIdByWorktree),
    browserTabsByWorktree: mergeRecord(base.browserTabsByWorktree, source.browserTabsByWorktree),
    browserPagesByWorkspace,
    browserUrlHistory: mergeBrowserHistory(base.browserUrlHistory, source.browserUrlHistory),
    markdownFrontmatterVisible: {
      ...(ambiguousWorktreeIds.size === 0 ? source.markdownFrontmatterVisible : {}),
      ...base.markdownFrontmatterVisible
    },
    activeBrowserTabIdByWorktree: mergeRecord(
      base.activeBrowserTabIdByWorktree,
      source.activeBrowserTabIdByWorktree
    ),
    activeTabTypeByWorktree: mergeRecord(
      base.activeTabTypeByWorktree,
      source.activeTabTypeByWorktree
    ),
    activeTabIdByWorktree: mergeRecord(base.activeTabIdByWorktree, source.activeTabIdByWorktree),
    unifiedTabs: mergeRecord(base.unifiedTabs, source.unifiedTabs),
    tabGroups: mergeRecord(base.tabGroups, source.tabGroups),
    tabGroupLayouts: mergeRecord(base.tabGroupLayouts, source.tabGroupLayouts),
    activeGroupIdByWorktree: mergeRecord(
      base.activeGroupIdByWorktree,
      source.activeGroupIdByWorktree
    ),
    lastVisitedAtByWorktreeId: mergeRecord(
      base.lastVisitedAtByWorktreeId,
      source.lastVisitedAtByWorktreeId
    ),
    defaultTerminalTabsAppliedByWorktreeId: mergeRecord(
      base.defaultTerminalTabsAppliedByWorktreeId,
      source.defaultTerminalTabsAppliedByWorktreeId
    ),
    activeWorktreeIdsOnShutdown: mergeUnique(
      base.activeWorktreeIdsOnShutdown,
      source.activeWorktreeIdsOnShutdown?.filter((key) => reconciledKeys.has(key))
    ),
    activeConnectionIdsAtShutdown: mergeUnique(
      base.activeConnectionIdsAtShutdown,
      source.activeConnectionIdsAtShutdown
    ),
    remoteSessionIdsByTabId: input.remoteSessionIdsByTabId,
    sleepingAgentSessionsByPaneKey: input.sleepingAgentSessionsByPaneKey,
    terminalPtyIncarnationsByPaneKey: input.terminalPtyIncarnationsByPaneKey,
    terminalTopologyRevisionByRepoId: mergeTopologyRevisions(
      base.terminalTopologyRevisionByRepoId,
      Object.fromEntries(
        Object.entries(source.terminalTopologyRevisionByRepoId ?? {}).filter(
          ([repoId]) =>
            ![...ambiguousWorktreeIds].some((key) => repoIdForWorkspaceKey(key) === repoId)
        )
      )
    ),
    terminalSurfaceTombstonesByPaneKey: input.terminalSurfaceTombstonesByPaneKey
  }
}
