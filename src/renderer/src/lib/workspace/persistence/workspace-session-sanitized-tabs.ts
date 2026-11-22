import { pendingAgentLaunchPane } from '../../../../../shared/agent-launch/contracts/agent-launch-pane-verdict'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { WorkspaceSessionSnapshot } from './workspace-session'

type SanitizedTabs = WorkspaceSessionState['tabsByWorktree'][string]

// Keyed by the store's tab arrays: an untouched workspace keeps its saved array, so the acknowledged diff skips it by identity.
const sanitizedByTabs = new WeakMap<
  WorkspaceSessionSnapshot['tabsByWorktree'][string],
  SanitizedTabs
>()

function sanitizeTabs(tabs: WorkspaceSessionSnapshot['tabsByWorktree'][string]): SanitizedTabs {
  const cached = sanitizedByTabs.get(tabs)
  if (cached) {
    return cached
  }
  const sanitized = tabs.map((tab) => {
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
  sanitizedByTabs.set(tabs, sanitized)
  return sanitized
}

export function buildSanitizedTabsByWorktree(
  tabsByWorktree: WorkspaceSessionSnapshot['tabsByWorktree']
): WorkspaceSessionState['tabsByWorktree'] {
  // Why: strip transient pendingActivationSpawn — session:set persists without Zod re-parse, so a stale flag would drop the first PTY spawn on restart.
  // Same for the recovery ledger: it describes a mounted pane's in-flight heal, so a persisted one would refuse the first recovery after restart.
  // A launch pane's outcome is not saved: a reload asks main again, which keeps it until it quits; after a restart the pane spawns like any other.
  return Object.fromEntries(
    Object.entries(tabsByWorktree).map(([worktreeId, tabs]) => [worktreeId, sanitizeTabs(tabs)])
  )
}
