import { pendingAgentLaunchPane } from '../../../shared/agent-launch-pane-verdict'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { AppState } from '../store'

export function buildSanitizedTabsByWorktree(
  tabsByWorktree: AppState['tabsByWorktree']
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
