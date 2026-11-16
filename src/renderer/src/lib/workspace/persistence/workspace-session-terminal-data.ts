import { pendingAgentLaunchPane } from '../../../../../shared/agent-launch/contracts/agent-launch-pane-verdict'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { WorkspaceSessionSnapshot } from './workspace-session'

export function buildSanitizedTabsByWorktree(
  tabsByWorktree: WorkspaceSessionSnapshot['tabsByWorktree']
): WorkspaceSessionState['tabsByWorktree'] {
  // Why: strip transient pendingActivationSpawn — session:set persists without Zod re-parse, so a stale flag would drop the first PTY spawn on restart.
  // Same for the recovery ledger: it describes a mounted pane's in-flight heal, so a persisted one would refuse the first recovery after restart.
  // A launch pane's outcome is not saved: a reload asks main again, which keeps it until it quits; after a restart the pane spawns like any other.
  return Object.fromEntries(
    Object.entries(tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => {
        const {
          pendingActivationSpawn: _unused,
          recovery: _recovery,
          restoredFromSession: _restored,
          ...rest
        } = tab
        void _unused
        void _recovery
        void _restored
        return rest.agentLaunchPane
          ? { ...rest, agentLaunchPane: pendingAgentLaunchPane(rest.agentLaunchPane) }
          : rest
      })
    ])
  )
}

export function buildTerminalSessionData(
  snapshot: WorkspaceSessionSnapshot
): Pick<WorkspaceSessionState, 'activeWorktreeIdsOnShutdown' | 'remoteSessionIdsByTabId'> {
  const tabsByWorktree = snapshot.tabsByWorktree

  // Why: use ptyIdsByTabId (live PTYs), not tab.ptyId, which sleep preserves as a wake hint and would revive slept worktrees as active.
  const ptyIdsByTabId = snapshot.ptyIdsByTabId
  const hasLivePty = (tabId: string): boolean => (ptyIdsByTabId[tabId]?.length ?? 0) > 0

  // Why: relay reconnect keeps lastKnown but clears tab.ptyId; the !tab.ptyId guard excludes slept tabs (which keep ptyId as a wake hint).
  const lastKnown = snapshot.lastKnownRelayPtyIdByTabId
  // During fresh hydration reconnect maps alone retain relay handles after live/tab bindings clear (#17743); omitting them republishes temporary absence over surviving sessions.
  const pendingReconnect = snapshot.pendingReconnectPtyIdByTabId ?? {}
  const deferredSshSessions = snapshot.deferredSshSessionIdsByTabId ?? {}
  const restoredSessionId = (tabId: string): string | undefined =>
    lastKnown[tabId] || pendingReconnect[tabId] || deferredSshSessions[tabId]
  const hasReconnectableSession = (tab: { id: string; ptyId: string | null }): boolean =>
    hasLivePty(tab.id) || (!tab.ptyId && Boolean(restoredSessionId(tab.id)))

  const activeWorktreeIdsOnShutdown = Object.entries(tabsByWorktree)
    .filter(([, tabs]) => tabs.some(hasReconnectableSession))
    .map(([worktreeId]) => worktreeId)

  const worktreeById = new Map(
    Object.values(snapshot.worktreesByRepo)
      .flat()
      .map((worktree) => [worktree.id, worktree])
  )
  const repoById = new Map(snapshot.repos.map((repo) => [repo.id, repo]))

  // Derive reconnect targets locally with preindexed ownership; fragile synchronous IPC can drop under shutdown pressure, while per-tab catalog rescans delay quit.
  const remoteSessionIdsByTabId: Record<string, string> = {}
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const worktree = worktreeById.get(worktreeId)
    const repo = worktree ? repoById.get(worktree.repoId) : null
    if (!repo?.connectionId) {
      continue
    }
    for (const tab of tabs) {
      if (!hasReconnectableSession(tab)) {
        continue
      }
      const sessionId = tab.ptyId || restoredSessionId(tab.id)
      if (sessionId) {
        remoteSessionIdsByTabId[tab.id] = sessionId
      }
    }
  }

  return {
    activeWorktreeIdsOnShutdown,
    remoteSessionIdsByTabId:
      Object.keys(remoteSessionIdsByTabId).length > 0 ? remoteSessionIdsByTabId : undefined
  }
}
