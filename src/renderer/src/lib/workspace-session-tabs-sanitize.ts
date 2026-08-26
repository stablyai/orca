import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

export function buildSanitizedTabsByWorktree(
  tabsByWorktree: Record<string, TerminalTab[]>
): WorkspaceSessionState['tabsByWorktree'] {
  // Why: strip transient pendingActivationSpawn — session:set persists without Zod re-parse, so a stale flag would drop the first PTY spawn on restart.
  return Object.fromEntries(
    Object.entries(tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => {
        const { pendingActivationSpawn: _unused, ...rest } = tab
        void _unused
        return rest
      })
    ])
  )
}
