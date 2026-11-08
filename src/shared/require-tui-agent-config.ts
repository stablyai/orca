import type { TuiAgent } from './agent-launch/catalog/tui-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from './agent-launch/catalog/tui-agent-config'
import type { TuiAgentConfig } from './agent-launch/catalog/tui-agent-config-types'

/** Persisted agent IDs can outlive branch builds; name unknown IDs instead of throwing an unreadable property-access error. */
export function requireTuiAgentConfig(agent: TuiAgent): TuiAgentConfig {
  if (!isTuiAgent(agent)) {
    throw new Error(
      `Unknown agent "${String(agent)}". This version of Orca has no such agent — pick a different agent and try again.`
    )
  }
  return TUI_AGENT_CONFIG[agent]
}
