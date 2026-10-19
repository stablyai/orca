export const AGENT_LAUNCH_TAB_CLOSED_CODE = 'agent_launch_tab_closed' as const

// The user closed the launch's tab while its agent was starting: the launch was stopped, and that
// is its answer. Only a client advertising `agent.launch.tab-closed.v1` is told so; any other reads
// the uncertain answer it always got.
export class AgentLaunchTabClosedError extends Error {
  constructor() {
    super(AGENT_LAUNCH_TAB_CLOSED_CODE)
    this.name = 'AgentLaunchTabClosedError'
  }
}
