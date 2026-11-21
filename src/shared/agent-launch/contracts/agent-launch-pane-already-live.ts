export const AGENT_LAUNCH_PANE_ALREADY_LIVE_CODE = 'agent_launch_pane_already_live' as const

// The reserved pane already backs a live terminal; refused before any handle, snapshot or reveal.
export class AgentLaunchPaneAlreadyLiveError extends Error {
  constructor() {
    super(AGENT_LAUNCH_PANE_ALREADY_LIVE_CODE)
    this.name = 'AgentLaunchPaneAlreadyLiveError'
  }
}
