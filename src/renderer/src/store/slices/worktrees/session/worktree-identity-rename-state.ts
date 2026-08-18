import type { AppState } from '../../../types'
import { splitWorktreeIdForFilesystem } from '../../../../../../shared/worktree/id'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  remapClosedTerminalTabSnapshotCwds,
  type ClosedTerminalTabSnapshot
} from '../../recently-closed-tabs'

// Every worktree-id-keyed store map the rename path re-keys, so a new `*ByWorktree` map isn't silently missed.
// Tab-id/file-id-keyed maps are deliberately excluded: tabs and files keep their ids across a rename.
const WORKTREE_ID_KEYED_MAP_KEYS = [
  'worktreeLineageById',
  'tabsByWorktree',
  'deleteStateByWorktreeId',
  'baseStatusByWorktreeId',
  'remoteBranchConflictByWorktreeId',
  'fileSearchStateByWorktree',
  'browserTabsByWorktree',
  'recentlyClosedBrowserTabsByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeFileIdByWorktree',
  'activeTabTypeByWorktree',
  'activeTabIdByWorktree',
  'tabBarOrderByWorktree',
  'pendingReconnectTabByWorktree',
  'rightSidebarTabByWorktree',
  'rightSidebarExplorerViewByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'activeGroupIdByWorktree',
  'gitStatusByWorktree',
  'gitStatusHeadByWorktree',
  'gitBranchLineTotalByWorktree',
  'gitIgnoredPathsByWorktree',
  'gitConflictOperationByWorktree',
  'trackedConflictPathsByWorktree',
  'gitBranchChangesByWorktree',
  'gitBranchCompareSummaryByWorktree',
  'gitBranchCompareRequestKeyByWorktree',
  'gitBranchCompareRequestStatusHeadByWorktree',
  'showDotfilesByWorktree',
  'expandedDirs',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId',
  'recentlyClosedTabKindsByWorktree'
] as const satisfies readonly (keyof AppState)[]

/**
 * Re-key every worktree-id-keyed map from `oldWorktreeId` to `newWorktreeId` after a folder
 * rename. Tab-id/file-id-keyed maps stay put since tabs/files keep their ids; the
 * active/renaming pointers are worktree-id-valued, so they're re-pointed too.
 * Main-process counterpart: `Store.migrateWorktreeIdentity` in persistence.ts.
 */
export function buildWorktreeRenameState(
  s: AppState,
  oldWorktreeId: string,
  newWorktreeId: string
): Partial<AppState> {
  if (oldWorktreeId === newWorktreeId) {
    return {}
  }
  const renamed: Record<string, unknown> = {}
  const renameKey = <T>(
    key: keyof AppState,
    mapValue: (value: T) => T = (value) => value
  ): void => {
    const map = s[key as keyof AppState] as Record<string, unknown> | undefined
    if (!map || !(oldWorktreeId in map)) {
      return
    }
    const next = { ...map }
    next[newWorktreeId] = mapValue(next[oldWorktreeId] as T)
    delete next[oldWorktreeId]
    renamed[key] = next
  }
  const withNewWorktreeId = <T extends { worktreeId: string }>(value: T): T =>
    value.worktreeId === oldWorktreeId ? { ...value, worktreeId: newWorktreeId } : value
  const renameValueByKey: Partial<Record<(typeof WORKTREE_ID_KEYED_MAP_KEYS)[number], unknown>> = {
    tabsByWorktree: (tabs: { worktreeId: string }[]) => tabs.map(withNewWorktreeId),
    browserTabsByWorktree: (workspaces: { worktreeId: string }[]) =>
      workspaces.map(withNewWorktreeId),
    recentlyClosedBrowserTabsByWorktree: (
      snapshots: { workspace: { worktreeId: string }; pages: { worktreeId: string }[] }[]
    ) =>
      snapshots.map((snapshot) => ({
        ...snapshot,
        workspace: withNewWorktreeId(snapshot.workspace),
        pages: snapshot.pages.map(withNewWorktreeId)
      })),
    fileSearchStateByWorktree: (searchState: AppState['fileSearchStateByWorktree'][string]) => ({
      ...searchState,
      resultOwner: searchState.resultOwner ? withNewWorktreeId(searchState.resultOwner) : null
    }),
    unifiedTabsByWorktree: (tabs: { worktreeId: string }[]) => tabs.map(withNewWorktreeId),
    groupsByWorktree: (groups: { worktreeId: string }[]) => groups.map(withNewWorktreeId)
  }
  for (const key of WORKTREE_ID_KEYED_MAP_KEYS) {
    renameKey(key, renameValueByKey[key] as ((value: unknown) => unknown) | undefined)
  }
  // Re-key on rename so a renamed worktree keeps its editor-undo + push/pull state.
  renameKey('recentlyClosedEditorTabsByWorktree', (files: { worktreeId: string }[]) =>
    files.map(withNewWorktreeId)
  )
  // Why: terminal reopen snapshots hold absolute startupCwd paths under the old folder; remap or Cmd+Shift+T respawns into a directory that no longer exists after the rename.
  const oldWorktreePath = splitWorktreeIdForFilesystem(oldWorktreeId)?.worktreePath
  const newWorktreePath = splitWorktreeIdForFilesystem(newWorktreeId)?.worktreePath
  renameKey('recentlyClosedTerminalTabsByWorktree', (snapshots: ClosedTerminalTabSnapshot[]) =>
    oldWorktreePath && newWorktreePath
      ? remapClosedTerminalTabSnapshotCwds(snapshots, oldWorktreePath, newWorktreePath)
      : snapshots
  )
  renameKey('remoteStatusesByWorktree')

  const openFiles = s.openFiles?.some((f) => f.worktreeId === oldWorktreeId)
    ? s.openFiles.map((f) =>
        f.worktreeId === oldWorktreeId ? { ...f, worktreeId: newWorktreeId } : f
      )
    : s.openFiles
  const currentBrowserPagesByWorkspace = s.browserPagesByWorkspace ?? {}
  const browserPagesByWorkspace = Object.values(currentBrowserPagesByWorkspace).some((pages) =>
    pages.some((page) => page.worktreeId === oldWorktreeId)
  )
    ? Object.fromEntries(
        Object.entries(currentBrowserPagesByWorkspace).map(([workspaceId, pages]) => [
          workspaceId,
          pages.map(withNewWorktreeId)
        ])
      )
    : s.browserPagesByWorkspace
  const currentRecentlyClosedBrowserPagesByWorkspace = s.recentlyClosedBrowserPagesByWorkspace ?? {}
  const recentlyClosedBrowserPagesByWorkspace = Object.values(
    currentRecentlyClosedBrowserPagesByWorkspace
  ).some((pages) => pages.some((page) => page.worktreeId === oldWorktreeId))
    ? Object.fromEntries(
        Object.entries(currentRecentlyClosedBrowserPagesByWorkspace).map(([workspaceId, pages]) => [
          workspaceId,
          pages.map(withNewWorktreeId)
        ])
      )
    : s.recentlyClosedBrowserPagesByWorkspace
  let everActivated = s.everActivatedWorktreeIds
  if (everActivated.has(oldWorktreeId)) {
    everActivated = new Set(everActivated)
    everActivated.delete(oldWorktreeId)
    everActivated.add(newWorktreeId)
  }
  const pendingReconnectWorktreeIds = s.pendingReconnectWorktreeIds?.includes(oldWorktreeId)
    ? s.pendingReconnectWorktreeIds.map((id) => (id === oldWorktreeId ? newWorktreeId : id))
    : s.pendingReconnectWorktreeIds
  const currentSleepingAgentSessionsByPaneKey = s.sleepingAgentSessionsByPaneKey ?? {}
  const sleepingAgentSessionsByPaneKey = Object.values(currentSleepingAgentSessionsByPaneKey).some(
    (record) => record.worktreeId === oldWorktreeId
  )
    ? Object.fromEntries(
        Object.entries(currentSleepingAgentSessionsByPaneKey).map(([paneKey, record]) => [
          paneKey,
          record.worktreeId === oldWorktreeId ? { ...record, worktreeId: newWorktreeId } : record
        ])
      )
    : s.sleepingAgentSessionsByPaneKey

  return {
    ...(renamed as Partial<AppState>),
    ...(openFiles !== s.openFiles ? { openFiles } : {}),
    ...(browserPagesByWorkspace !== s.browserPagesByWorkspace ? { browserPagesByWorkspace } : {}),
    ...(recentlyClosedBrowserPagesByWorkspace !== s.recentlyClosedBrowserPagesByWorkspace
      ? { recentlyClosedBrowserPagesByWorkspace }
      : {}),
    ...(everActivated !== s.everActivatedWorktreeIds
      ? { everActivatedWorktreeIds: everActivated }
      : {}),
    ...(pendingReconnectWorktreeIds !== s.pendingReconnectWorktreeIds
      ? { pendingReconnectWorktreeIds }
      : {}),
    ...(sleepingAgentSessionsByPaneKey !== s.sleepingAgentSessionsByPaneKey
      ? { sleepingAgentSessionsByPaneKey }
      : {}),
    ...(s.activeWorktreeId === oldWorktreeId ? { activeWorktreeId: newWorktreeId } : {}),
    // The active workspace key derives from the worktree id, so keep it in sync when the active worktree is renamed.
    ...(s.activeWorkspaceKey === worktreeWorkspaceKey(oldWorktreeId)
      ? { activeWorkspaceKey: worktreeWorkspaceKey(newWorktreeId) }
      : {}),
    ...(s.renamingWorktreeId?.worktreeId === oldWorktreeId
      ? { renamingWorktreeId: { ...s.renamingWorktreeId, worktreeId: newWorktreeId } }
      : {})
  }
}
