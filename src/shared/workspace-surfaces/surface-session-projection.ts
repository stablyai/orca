import type { SurfaceSessionProjectionCache } from './surface-session-projection-cache'
import type { ExecutionHostId } from '../execution-host'
import type { WorkspaceSessionState } from '../workspace-session/workspace-session-state-types'
import { loadWorkspaceLayoutWithoutReport } from '../workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../workspace-layout/workspace-layout-save'
import type { WorkspaceSurface } from './surface-content'
import { projectSurfaceWorkspace } from './surface-layout'
import { parsePaneKey } from '../workspace-layout/stable-pane-id'

export function unresolvedSurfaceNativeSessionIds(
  surfaces: readonly WorkspaceSurface[],
  nativeTabs: readonly { sessionId: string }[] = []
): ReadonlySet<string> {
  const known = new Set(
    surfaces.flatMap((surface) =>
      surface.content?.kind === 'agent-session' ? [surface.content.sessionId] : []
    )
  )
  return new Set(nativeTabs.filter((tab) => !known.has(tab.sessionId)).map((tab) => tab.sessionId))
}

/** Use canonical membership for current readers and compatibility output, retaining the device view. */
export function projectSurfaceSession(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  surfaces: readonly WorkspaceSurface[],
  chatVerified = true,
  unresolvedNativeSessionIds: ReadonlySet<string> = new Set(),
  shownNativeSessionIds: ReadonlySet<string> = new Set(),
  projectionCache?: SurfaceSessionProjectionCache
): WorkspaceSessionState {
  const loaded = loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext())
  const byWorkspace = new Map<string, WorkspaceSurface[]>()
  for (const surface of projectionCache ? [] : surfaces) {
    if (surface.hostId === hostId) {
      const rows = byWorkspace.get(surface.workspaceId) ?? []
      rows.push(surface)
      byWorkspace.set(surface.workspaceId, rows)
    }
  }
  const scopes = new Set([
    ...Object.keys(loaded.layout.workspaces),
    ...(projectionCache?.workspaceIds() ?? byWorkspace.keys())
  ])
  for (const workspaceId of scopes) {
    loaded.layout.workspaces[workspaceId] = projectionCache
      ? projectionCache.project(
          workspaceId,
          loaded.layout.workspaces[workspaceId],
          chatVerified,
          unresolvedNativeSessionIds,
          shownNativeSessionIds
        )
      : projectSurfaceWorkspace(
          workspaceId,
          loaded.layout.workspaces[workspaceId],
          byWorkspace.get(workspaceId) ?? [],
          chatVerified,
          unresolvedNativeSessionIds,
          shownNativeSessionIds
        )
  }
  const activeEntities =
    projectionCache?.terminalEntityIds ??
    new Set(
      surfaces.flatMap((surface) =>
        surface.hostId === hostId && surface.content?.kind === 'terminal'
          ? [surface.content.entityId]
          : []
      )
    )
  const removed = new Set(
    Object.values(session.tabsByWorktree).flatMap((tabs) =>
      tabs.filter((tab) => !activeEntities.has(tab.id)).map((tab) => tab.id)
    )
  )
  // Drop the retired surfaces' exports; unrelated recovery records remain recoverable.
  loaded.carried.unownedTerminalLayouts = Object.fromEntries(
    Object.entries(loaded.carried.unownedTerminalLayouts).filter(([id]) => !removed.has(id))
  )
  loaded.carried.unplacedIncarnations = Object.fromEntries(
    Object.entries(loaded.carried.unplacedIncarnations).filter(
      ([key]) => !removed.has(parsePaneKey(key)?.tabId ?? '')
    )
  )
  loaded.carried.unplacedSleepingRecords = Object.fromEntries(
    Object.entries(loaded.carried.unplacedSleepingRecords).filter(
      ([key]) => !removed.has(parsePaneKey(key)?.tabId ?? '')
    )
  )
  const projected = saveWorkspaceLayout(loaded)
  return {
    ...session,
    tabsByWorktree: projected.tabsByWorktree,
    terminalLayoutsByTabId: projected.terminalLayoutsByTabId,
    unifiedTabs: projected.unifiedTabs,
    tabGroups: projected.tabGroups,
    tabGroupLayouts: projected.tabGroupLayouts,
    sleepingAgentSessionsByPaneKey: projected.sleepingAgentSessionsByPaneKey,
    terminalPtyIncarnationsByPaneKey: projected.terminalPtyIncarnationsByPaneKey
  }
}
