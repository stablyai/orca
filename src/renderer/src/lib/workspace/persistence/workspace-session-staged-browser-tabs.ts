import type { WorkspaceSessionSnapshot } from './workspace-session'

type StagedBrowserTabSnapshotFields = Pick<
  WorkspaceSessionSnapshot,
  | 'activeBrowserTabIdByWorktree'
  | 'browserPagesByWorkspace'
  | 'browserTabsByWorktree'
  | 'remoteBrowserPageHandlesByPageId'
  | 'unifiedTabsByWorktree'
>

// The live array stays when nothing was dropped, so saves see that workspace as unchanged.
function keepWhenUnfiltered<T>(source: T[], filtered: T[]): T[] {
  return filtered.length === source.length ? source : filtered
}

type StagedBrowserPages = Pick<
  StagedBrowserTabSnapshotFields,
  'browserPagesByWorkspace' | 'remoteBrowserPageHandlesByPageId'
>

function isStagedBrowserWorkspace(snapshot: StagedBrowserPages, workspaceId: string): boolean {
  const handles = snapshot.remoteBrowserPageHandlesByPageId ?? {}
  const pages = snapshot.browserPagesByWorkspace[workspaceId] ?? []
  return pages.some((page) => handles[page.id]?.staged === true)
}

type UnifiedTabs = StagedBrowserTabSnapshotFields['unifiedTabsByWorktree'][string]

function withoutStagedBrowserUnifiedTabs(
  tabs: UnifiedTabs,
  isStaged: (workspaceId: string) => boolean
): UnifiedTabs {
  return keepWhenUnfiltered(
    tabs,
    tabs.filter((tab) => !(tab.contentType === 'browser' && isStaged(tab.entityId)))
  )
}

/** One workspace's unified tabs as `withoutStagedBrowserTabs` saves them. */
export function unifiedTabsWithoutStagedBrowsers(
  snapshot: StagedBrowserPages,
  tabs: UnifiedTabs
): UnifiedTabs {
  return withoutStagedBrowserUnifiedTabs(tabs, (workspaceId) =>
    isStagedBrowserWorkspace(snapshot, workspaceId)
  )
}

/** Drop unpublished optimistic browser tabs on restore; their page IDs have no host owner and would resurrect invalid workspaces. */
export function withoutStagedBrowserTabs<T extends StagedBrowserTabSnapshotFields>(snapshot: T): T {
  const stagedWorkspaceIds = new Set<string>()
  for (const workspaceId of Object.keys(snapshot.browserPagesByWorkspace)) {
    if (isStagedBrowserWorkspace(snapshot, workspaceId)) {
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
        keepWhenUnfiltered(
          workspaces,
          workspaces.filter((workspace) => !stagedWorkspaceIds.has(workspace.id))
        )
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
        withoutStagedBrowserUnifiedTabs(tabs, (workspaceId) => stagedWorkspaceIds.has(workspaceId))
      ])
    )
  }
}
