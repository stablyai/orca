import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { AppState } from '../../types'

// Why: launchAgent lives on the legacy terminal tab (keyed by entityId); toggle telemetry attributes by it.
export function launchAgentOf(
  state: AppState,
  worktreeId: string,
  entityId: string
): TuiAgent | null {
  return (
    (state.tabsByWorktree[worktreeId] ?? []).find((terminal) => terminal.id === entityId)
      ?.launchAgent ?? null
  )
}
