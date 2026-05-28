import type { TerminalLayoutSnapshot, TerminalTab } from './types'

export type RemoteWorkspaceTerminalTab = Omit<TerminalTab, 'worktreeId'> & {
  worktreePath: string
}

export type RemoteWorkspaceSession = {
  activeWorktreePath: string | null
  activeTabId: string | null
  tabsByWorktreePath: Record<string, RemoteWorkspaceTerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  activeWorktreePathsOnShutdown?: string[]
  activeTabIdByWorktreePath?: Record<string, string | null>
  remoteSessionIdsByTabId?: Record<string, string>
  lastVisitedAtByWorktreePath?: Record<string, number>
}

export type RemoteWorkspaceSnapshot = {
  namespace: string
  revision: number
  updatedAt: number
  schemaVersion: number
  session: RemoteWorkspaceSession
}

export type RemoteWorkspaceConnectedClient = {
  clientId: string
  name: string
  lastSeenAt: number
  isCurrent?: boolean
}

export type RemoteWorkspacePatch = {
  kind: 'replace-session'
  session: RemoteWorkspaceSession
}

export type RemoteWorkspacePatchResult =
  | {
      ok: true
      snapshot: RemoteWorkspaceSnapshot
    }
  | {
      ok: false
      reason: 'stale-revision' | 'unavailable'
      snapshot?: RemoteWorkspaceSnapshot
      message?: string
    }

export type RemoteWorkspaceChangedEvent = {
  targetId: string
  snapshot: RemoteWorkspaceSnapshot
  sourceClientId?: string
}
