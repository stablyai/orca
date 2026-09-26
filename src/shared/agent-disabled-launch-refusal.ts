import type { TuiAgent } from './tui-agent'
import { isTuiAgentEnabled } from './tui-agent-selection'

/** A launch named an agent the user turned off; raised before anything is created. */
export class AgentDisabledLaunchError extends Error {
  constructor(readonly agent: TuiAgent) {
    super(`Agent ${agent} is disabled. Choose an enabled agent.`)
    this.name = 'AgentDisabledLaunchError'
  }
}

export function refuseDisabledAgentLaunch(
  agent: TuiAgent,
  disabledTuiAgents: Iterable<unknown> | null | undefined
): void {
  if (!isTuiAgentEnabled(agent, disabledTuiAgents)) {
    throw new AgentDisabledLaunchError(agent)
  }
}
