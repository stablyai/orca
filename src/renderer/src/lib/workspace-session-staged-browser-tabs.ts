import type { WorkspaceSessionSnapshot } from './workspace-session'

type StagedBrowserTabSnapshotFields = Pick<
  WorkspaceSessionSnapshot,
  | 'activeBrowserTabIdByWorktree'
  | 'browserPagesByWorkspace'
  | 'browserTabsByWorktree'
  | 'remoteBrowserPageHandlesByPageId'
  | 'unifiedTabsByWorktree'
>

/**
 * Drop browser tabs this client staged optimistically but the host never published. Restoring one
 * would resurrect a workspace pointing at a page id no runtime has ever heard of, so a create that
 * was still in flight at save time must simply not survive the reload.
 */
export function withoutStagedBrowserTabs<T extends StagedBrowserTabSnapshotFields>(snapshot: T): T {
  const handles = snapshot.remoteBrowserPageHandlesByPageId ?? {}
  const stagedWorkspaceIds = new Set<string>()
  for (const [workspaceId, pages] of Object.entries(snapshot.browserPagesByWorkspace)) {
    if (pages.some((page) => handles[page.id]?.staged === true)) {
      stagedWorkspaceIds.add(workspaceId)
    }
  }
  if (stagedWorkspaceIds.size === 0) {
    return snapshot
  }

  const browserPagesByWorkspace = { ...snapshot.browserPagesByWorkspace }
  for (const workspaceId of stagedWorkspaceIds) {
    delete browserPagesByWorkspace[workspaceId]
  }

  return {
    ...snapshot,
    browserTabsByWorktree: Object.fromEntries(
      Object.entries(snapshot.browserTabsByWorktree).map(([worktreeId, workspaces]) => [
        worktreeId,
        workspaces.filter((workspace) => !stagedWorkspaceIds.has(workspace.id))
      ])
    ),
    browserPagesByWorkspace,
    activeBrowserTabIdByWorktree: Object.fromEntries(
      Object.entries(snapshot.activeBrowserTabIdByWorktree).map(([worktreeId, workspaceId]) => [
        worktreeId,
        workspaceId && stagedWorkspaceIds.has(workspaceId) ? null : workspaceId
      ])
    ),
    // Why: the unified tab must go too — buildPersistedGroupsForWorktree derives each group's
    // tabOrder from the surviving tabs, so dropping it here also unwinds its slot and focus.
    unifiedTabsByWorktree: Object.fromEntries(
      Object.entries(snapshot.unifiedTabsByWorktree).map(([worktreeId, tabs]) => [
        worktreeId,
        tabs.filter(
          (tab) => !(tab.contentType === 'browser' && stagedWorkspaceIds.has(tab.entityId))
        )
      ])
    )
  }
}
