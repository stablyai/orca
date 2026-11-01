import { isTuiAgent, TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function isContinuationAgentAllowed(
  agent: TuiAgent,
  sourceAgent: TuiAgent | null | undefined,
  avoidSourceAgent = false
): boolean {
  // Launch modes of the same CLI still share its usage limit.
  return (
    !avoidSourceAgent ||
    !sourceAgent ||
    TUI_AGENT_CONFIG[agent].expectedProcess !== TUI_AGENT_CONFIG[sourceAgent].expectedProcess
  )
}

export function chooseInitialContinuationAgent(args: {
  availableAgents: TuiAgent[]
  automaticAgents: readonly TuiAgent[]
  sourceAgent: TuiAgent | null
  defaultAgent: unknown
}): TuiAgent | null {
  if (args.sourceAgent && args.availableAgents.includes(args.sourceAgent)) {
    return args.sourceAgent
  }
  if (isTuiAgent(args.defaultAgent) && args.availableAgents.includes(args.defaultAgent)) {
    return args.defaultAgent
  }
  return args.automaticAgents[0] ?? null
}
