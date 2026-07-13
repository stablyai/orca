import type { AgentId, CustomAgentDefinition } from '../../../../shared/custom-agent'
import { customAgentForId, isCustomAgentId } from '../../../../shared/custom-agent'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'

// Why: `isTuiAgentEnabled` no-ops (always true) for custom agent ids, so a
// disabled/deleted custom agent set as `defaultTuiAgent` must be checked
// against its own `enabled` flag instead of falling through as "enabled".
export function resolveDefaultAutomationAgent(args: {
  defaultTuiAgent: AgentId | 'blank' | null | undefined
  disabledTuiAgents: Iterable<unknown> | null | undefined
  customAgents: readonly CustomAgentDefinition[] | undefined
  fallback: AgentId
}): AgentId {
  const { defaultTuiAgent, disabledTuiAgents, customAgents, fallback } = args
  if (!defaultTuiAgent || defaultTuiAgent === 'blank') {
    return fallback
  }
  const enabled = isCustomAgentId(defaultTuiAgent)
    ? customAgentForId(defaultTuiAgent, customAgents)?.enabled === true
    : isTuiAgentEnabled(defaultTuiAgent, disabledTuiAgents)
  return enabled ? defaultTuiAgent : fallback
}
