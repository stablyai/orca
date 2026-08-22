// Why: launch surfaces need one answer to "are Orca's managed status hooks on
// for this agent" — the global toggle and the per-agent opt-out both count, and
// a surface that checks only one of them plans the wrong launch (#11941).

import { normalizeDisabledTuiAgents } from './tui-agent-selection'
import type { TuiAgent } from './tui-agent'

/** The settings a launch surface must hand a plan builder so the builder can
 *  decide hooks itself. Structural, so callers pass `GlobalSettings` directly. */
export type AgentStatusHookSettings = {
  agentStatusHooksEnabled?: boolean
  disabledTuiAgents?: readonly string[]
}

export function areAgentStatusHooksEnabledForAgent(
  settings: AgentStatusHookSettings | null | undefined,
  agent: TuiAgent
): boolean {
  if (settings?.agentStatusHooksEnabled === false) {
    return false
  }
  return !normalizeDisabledTuiAgents(settings?.disabledTuiAgents).includes(agent)
}
