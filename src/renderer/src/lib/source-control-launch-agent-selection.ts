import { getAgentCatalog } from '@/lib/agent-catalog'
import { isCustomAgentId } from '../../../shared/commit-message-agent-spec'
import type { SourceControlActionRecipe } from '../../../shared/source-control-ai-actions'
import { filterEnabledTuiAgents } from '../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../shared/types'

export function readSourceControlLaunchRecipeAgentId(
  recipe: Pick<SourceControlActionRecipe, 'agentId'> | null | undefined
): TuiAgent | null {
  const agentId = recipe?.agentId
  return agentId && !isCustomAgentId(agentId) ? agentId : null
}

export function pickSourceControlLaunchAgent(args: {
  savedAgent?: TuiAgent | null
  defaultAgent: TuiAgent | 'blank' | null | undefined
  detectedAgents: TuiAgent[]
  disabledAgents?: TuiAgent[]
}): TuiAgent | null {
  const enabledAgents = filterEnabledTuiAgents(args.detectedAgents, args.disabledAgents)
  if (args.savedAgent && enabledAgents.includes(args.savedAgent)) {
    return args.savedAgent
  }
  if (
    args.defaultAgent &&
    args.defaultAgent !== 'blank' &&
    enabledAgents.includes(args.defaultAgent)
  ) {
    return args.defaultAgent
  }
  return getAgentCatalog().find((entry) => enabledAgents.includes(entry.id))?.id ?? null
}
