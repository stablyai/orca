import type { TuiAgent } from '../../../../shared/types'
import type { AgentId } from '../../../../shared/custom-agent'
import { isTuiAgent } from '../../../../shared/tui-agent-config'

type PaneKeyboardProtocolStartup = {
  launchAgent?: AgentId
}

/** Resolves only the agent owned by the startup payload for the pane being created. */
export function resolvePaneKeyboardProtocolAgent(
  startup: PaneKeyboardProtocolStartup | null | undefined,
  tabLaunchAgent?: AgentId | null
): TuiAgent | null {
  if (startup === undefined) {
    return tabLaunchAgent && isTuiAgent(tabLaunchAgent) ? tabLaunchAgent : null
  }
  return startup?.launchAgent && isTuiAgent(startup.launchAgent) ? startup.launchAgent : null
}
