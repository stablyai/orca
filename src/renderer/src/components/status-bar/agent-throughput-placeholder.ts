import { isAgentThroughputMeasured } from '../../../../shared/agent-throughput-types'

export type AgentThroughputPlaceholderReason =
  /** No terminal pane is focused, so there is nothing to measure. */
  | 'no-pane'
  /** The focused pane's agent writes no per-message token counts Orca can read. */
  | 'unmeasured-agent'
  /** A measurable (or not yet identified) agent that has not completed a message. */
  | 'waiting'

export function resolveAgentThroughputPlaceholderReason(args: {
  paneKey: string | null
  agentType: string | undefined
}): AgentThroughputPlaceholderReason {
  if (!args.paneKey) {
    return 'no-pane'
  }
  if (args.agentType && !isAgentThroughputMeasured(args.agentType)) {
    return 'unmeasured-agent'
  }
  return 'waiting'
}
