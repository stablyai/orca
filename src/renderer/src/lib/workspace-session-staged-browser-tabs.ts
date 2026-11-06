import type { WorkspaceSessionSnapshot } from './workspace-session'

type StagedBrowserTabSnapshotFields = Pick<
  WorkspaceSessionSnapshot,
  | 'activeBrowserTabIdByWorktree'
  | 'browserPagesByWorkspace'
  | 'browserTabsByWorktree'
  | 'remoteBrowserPageHandlesByPageId'
  | 'unifiedTabsByWorktree'
>

/** Drop unpublished optimistic browser tabs on restore; their page IDs have no host owner and would resurrect invalid workspaces. */
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
    // Drop unified tabs too so persisted group order/focus cannot retain staged slots.
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
