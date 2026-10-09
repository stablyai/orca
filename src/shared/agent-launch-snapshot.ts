import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

/** Execution-host launch facts; absent on older records and unobserved launches. */
export type AgentLaunchSnapshot = {
  agentId: TuiAgent
  /** Effective merged agent arguments, including host defaults; excludes the prompt. */
  effectiveAgentArgs: string
}

export function normalizeAgentLaunchSnapshot(value: unknown): AgentLaunchSnapshot | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('agentId' in value) ||
    !('effectiveAgentArgs' in value) ||
    !isTuiAgent(value.agentId) ||
    typeof value.effectiveAgentArgs !== 'string'
  ) {
    return undefined
  }
  return { agentId: value.agentId, effectiveAgentArgs: value.effectiveAgentArgs }
}
