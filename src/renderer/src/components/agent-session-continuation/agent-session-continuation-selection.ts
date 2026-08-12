import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'

export function chooseInitialContinuationAgent(args: {
  availableAgents: TuiAgent[]
  sourceAgent: TuiAgent | null
  defaultAgent: unknown
}): TuiAgent | null {
  if (args.sourceAgent && args.availableAgents.includes(args.sourceAgent)) {
    return args.sourceAgent
  }
  if (isTuiAgent(args.defaultAgent) && args.availableAgents.includes(args.defaultAgent)) {
    return args.defaultAgent
  }
  return args.availableAgents[0] ?? null
}
