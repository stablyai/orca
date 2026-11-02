import type { TuiAgent } from './tui-agent'
import { isTuiAgent, TUI_AGENT_CONFIG, type TuiAgentConfig } from './tui-agent-config'

/** Persisted agent IDs can outlive branch builds; name unknown IDs instead of throwing an unreadable property-access error. */
export function requireTuiAgentConfig(agent: TuiAgent): TuiAgentConfig {
  if (!isTuiAgent(agent)) {
    throw new Error(
      `Unknown agent "${String(agent)}". This version of Orca has no such agent — pick a different agent and try again.`
    )
  }
  return TUI_AGENT_CONFIG[agent]
}
