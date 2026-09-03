import type { TerminalLayoutSnapshot, TerminalTab } from './terminal-tab-types'

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
  defaultTerminalTabsAppliedByWorktreePath?: Record<string, true>
}

export type RemoteWorkspaceSnapshot = {
  namespace: string
  revision: number
  updatedAt: number
  schemaVersion: number
  session: RemoteWorkspaceSession
}

export type RemoteWorkspaceObservedSnapshot = RemoteWorkspaceSnapshot & {
  hostObservationToken: string
}

export type RemoteWorkspaceConnectedClient = {
  clientId: string
  name: string
  lastSeenAt: number
  isCurrent?: boolean
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

export type RemoteWorkspaceObservedPatchResult =
  | {
      ok: true
      snapshot: RemoteWorkspaceObservedSnapshot
    }
  | {
      ok: false
      reason: 'stale-revision' | 'unavailable'
      snapshot?: RemoteWorkspaceObservedSnapshot
      message?: string
    }

export const REMOTE_WORKSPACE_CHANGED_NOTIFICATION = 'workspace.changed'

/**
 * Sent instead of `workspace.changed` when the snapshot frame did not fit the client's producer
 * frame capacity. Carries no session: the client re-reads through `workspace.get`, whose response
 * lane is budgeted in megabytes rather than in one ~12KB producer frame.
 *
 * Wire contract: a relay that predates this never sends it, and a client that predates it drops it
 * the same way it drops any unknown notification method — which is exactly the silent drop this
 * replaces, so an un-negotiated pairing is never worse than before.
 */
export const REMOTE_WORKSPACE_STALE_NOTIFICATION = 'workspace.stale'

export type RemoteWorkspaceChangedEvent = {
  targetId: string
  snapshot: RemoteWorkspaceObservedSnapshot
  sourceClientId?: string
}
