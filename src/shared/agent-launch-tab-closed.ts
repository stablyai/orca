export const AGENT_LAUNCH_TAB_CLOSED_CODE = 'agent_launch_tab_closed' as const

// Tab closure during startup stops launch; only agent.launch.tab-closed.v1 clients receive this definite outcome.
export class AgentLaunchTabClosedError extends Error {
  constructor() {
    super(AGENT_LAUNCH_TAB_CLOSED_CODE)
    this.name = 'AgentLaunchTabClosedError'
  }
}
