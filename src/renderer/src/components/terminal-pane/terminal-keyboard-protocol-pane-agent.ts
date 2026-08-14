import type { TuiAgent } from '../../../../shared/tui-agent'

type PaneKeyboardProtocolStartup = {
  launchAgent?: TuiAgent
}

/** Resolves only the agent owned by the startup payload for the pane being created. */
export function resolvePaneKeyboardProtocolAgent(
  startup: PaneKeyboardProtocolStartup | null | undefined,
  tabLaunchAgent?: TuiAgent | null
): TuiAgent | null {
  if (startup === undefined) {
    return tabLaunchAgent ?? null
  }
  return startup?.launchAgent ?? null
}
