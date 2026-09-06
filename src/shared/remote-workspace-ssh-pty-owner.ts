import { parseExecutionHostId, type ExecutionHostId } from './execution-host'
import type { RemoteWorkspaceSession } from './remote-workspace-types'
import { parseAppSshPtyId, toAppSshPtyId } from './ssh-pty-id'

export function projectRemoteWorkspaceSshPtyOwner(
  session: RemoteWorkspaceSession,
  executionHostId: ExecutionHostId | undefined
): RemoteWorkspaceSession {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind !== 'ssh') {
    return session
  }
  // The authenticated host owns the snapshot; target IDs belong to each importing client.
  return mapSshPtyIds(session, (id) => {
    const parsed = parseAppSshPtyId(id)
    return parsed ? toAppSshPtyId(host.targetId, parsed.relayPtyId) : id
  })
}

export function stripRemoteWorkspaceSshPtyOwners(
  session: RemoteWorkspaceSession
): RemoteWorkspaceSession {
  return mapSshPtyIds(session, (id) => parseAppSshPtyId(id)?.relayPtyId ?? id)
}

function mapSshPtyIds(
  session: RemoteWorkspaceSession,
  project: (id: string) => string
): RemoteWorkspaceSession {
  const projectIds = (ids: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, project(id)]))
  return {
    ...session,
    tabsByWorktreePath: Object.fromEntries(
      Object.entries(session.tabsByWorktreePath).map(([path, tabs]) => [
        path,
        tabs.map((tab) => ({ ...tab, ptyId: tab.ptyId ? project(tab.ptyId) : tab.ptyId }))
      ])
    ),
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(session.terminalLayoutsByTabId).map(([id, layout]) => [
        id,
        layout.ptyIdsByLeafId
          ? { ...layout, ptyIdsByLeafId: projectIds(layout.ptyIdsByLeafId) }
          : layout
      ])
    ),
    remoteSessionIdsByTabId: session.remoteSessionIdsByTabId
      ? projectIds(session.remoteSessionIdsByTabId)
      : undefined
  }
}
