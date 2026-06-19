import { getAgentCatalogWithProfiles } from '@/lib/agent-catalog'
import { isCustomAgentId } from '../../../shared/commit-message-agent-spec'
import type { SourceControlActionRecipe } from '../../../shared/source-control-ai-actions'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import type { TuiAgent, TuiAgentProfile } from '../../../shared/types'

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
  profiles?: readonly TuiAgentProfile[] | null
}): TuiAgent | null {
  const detectedSet = new Set(args.detectedAgents)
  const availableAgents = getAgentCatalogWithProfiles(args.profiles)
    .filter((entry) => {
      return detectedSet.has(entry.baseAgent ?? entry.id)
    })
    .filter((entry) => isTuiAgentEnabled(entry.id, args.disabledAgents))
    .map((entry) => entry.id)
  if (args.savedAgent && availableAgents.includes(args.savedAgent)) {
    return args.savedAgent
  }
  if (
    args.defaultAgent &&
    args.defaultAgent !== 'blank' &&
    availableAgents.includes(args.defaultAgent)
  ) {
    return args.defaultAgent
  }
  return availableAgents[0] ?? null
}
