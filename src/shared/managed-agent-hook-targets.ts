import { AGENT_HOOK_TARGETS, type AgentHookTarget } from './agent-hook-types'
import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

export type ManagedAgentHookTarget = {
  agent: AgentHookTarget
  tuiAgent: TuiAgent
  executableCandidates: readonly string[]
}

function target(agent: AgentHookTarget): ManagedAgentHookTarget {
  return {
    agent,
    tuiAgent: agent,
    executableCandidates: getTuiAgentDetectCommands(TUI_AGENT_CONFIG[agent])
  }
}

export const MANAGED_AGENT_HOOK_TARGETS: readonly ManagedAgentHookTarget[] =
  AGENT_HOOK_TARGETS.map(target)

export function getManagedAgentHookTarget(
  agent: AgentHookTarget
): ManagedAgentHookTarget | undefined {
  return MANAGED_AGENT_HOOK_TARGETS.find((entry) => entry.agent === agent)
}

export function isManagedAgentHookTarget(value: unknown): value is AgentHookTarget {
  return (
    typeof value === 'string' && MANAGED_AGENT_HOOK_TARGETS.some((entry) => entry.agent === value)
  )
}
