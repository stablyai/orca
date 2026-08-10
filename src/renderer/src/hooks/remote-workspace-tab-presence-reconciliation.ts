import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { AppState } from '../store/types'

export type PendingTabPresence = 'present' | 'absent'

export type DirectSshTabMutationReconciliation = {
  acknowledgeSnapshot: (targetId: string, snapshot: RemoteWorkspaceSnapshot) => void
  beginSnapshotApply: (targetId: string) => () => void
  canApplySnapshot?: (targetId: string) => boolean
  pendingTabPresence: (targetId: string) => ReadonlyMap<string, PendingTabPresence>
}

export function postBoundaryLocalTabIds(
  remoteTabsByWorktree: WorkspaceSessionState['tabsByWorktree'],
  worktreeIds: ReadonlySet<string>,
  localTabsByWorktree: AppState['tabsByWorktree'],
  preexistingLocalTabIds: ReadonlySet<string>
): string[] {
  const remoteTabIds = new Set(
    [...worktreeIds].flatMap((worktreeId) =>
      (remoteTabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
    )
  )
  return [...worktreeIds]
    .flatMap((worktreeId) => localTabsByWorktree[worktreeId] ?? [])
    .map((tab) => tab.id)
    .filter((tabId) => !preexistingLocalTabIds.has(tabId) && !remoteTabIds.has(tabId))
}

export function postBoundaryDeletedTabIds(
  worktreeIds: ReadonlySet<string>,
  localTabsByWorktree: AppState['tabsByWorktree'],
  preexistingLocalTabIds: ReadonlySet<string>
): string[] {
  const currentTabIds = new Set(
    [...worktreeIds].flatMap((worktreeId) =>
      (localTabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
    )
  )
  return [...preexistingLocalTabIds].filter((tabId) => !currentTabIds.has(tabId))
}

export function graftLocalTabsIntoRemoteSession(
  remoteSession: WorkspaceSessionState,
  worktreeIds: ReadonlySet<string>,
  localTabsByWorktree: AppState['tabsByWorktree'],
  graftTabIds: ReadonlySet<string>
): WorkspaceSessionState {
  if (graftTabIds.size === 0) {
    return remoteSession
  }
  const tabsByWorktree = { ...remoteSession.tabsByWorktree }
  for (const worktreeId of worktreeIds) {
    const extras = (localTabsByWorktree[worktreeId] ?? []).filter((tab) => graftTabIds.has(tab.id))
    if (extras.length > 0) {
      tabsByWorktree[worktreeId] = [...(tabsByWorktree[worktreeId] ?? []), ...extras]
    }
  }
  return { ...remoteSession, tabsByWorktree }
}

export function omitPendingLocalTabDeletions(
  remoteSession: WorkspaceSessionState,
  deletedTabIds: ReadonlySet<string>
): WorkspaceSessionState {
  if (deletedTabIds.size === 0) {
    return remoteSession
  }
  const tabsByWorktree = Object.fromEntries(
    Object.entries(remoteSession.tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.filter((tab) => !deletedTabIds.has(tab.id))
    ])
  )
  const activeTabIdByWorktree = Object.fromEntries(
    Object.entries(remoteSession.activeTabIdByWorktree ?? {}).map(([worktreeId, tabId]) => [
      worktreeId,
      tabId && deletedTabIds.has(tabId) ? null : tabId
    ])
  )
  return {
    ...remoteSession,
    activeTabId:
      remoteSession.activeTabId && deletedTabIds.has(remoteSession.activeTabId)
        ? null
        : remoteSession.activeTabId,
    tabsByWorktree,
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(remoteSession.terminalLayoutsByTabId).filter(
        ([tabId]) => !deletedTabIds.has(tabId)
      )
    ),
    activeTabIdByWorktree,
    remoteSessionIdsByTabId: Object.fromEntries(
      Object.entries(remoteSession.remoteSessionIdsByTabId ?? {}).filter(
        ([tabId]) => !deletedTabIds.has(tabId)
      )
    )
  }
}
