import type { GlobalSettings } from '../../../settings/global-settings-types'
import { AI_TEXT_ACTION_IDS } from '../recipes/source-control-ai-actions'
import { hasActionAgentRecipe } from '../recipes/source-control-ai-command-template'
import { isRetiredTextAgent } from './commit-message-agent-spec'

/** The settings a client sends with a generation call so its own Source Control AI picks the agent, not the host's. */
export type CommitMessageGenerationSettings = Partial<
  Pick<
    GlobalSettings,
    'commitMessageAi' | 'sourceControlAi' | 'agentCmdOverrides' | 'defaultTuiAgent'
  >
>

// Hosts from before a text agent retired would still run a saved choice of it.
function withoutRetiredTextAgents(
  sourceControlAi: NonNullable<GlobalSettings['sourceControlAi']>,
  defaultTuiAgent: GlobalSettings['defaultTuiAgent'] | undefined
): NonNullable<GlobalSettings['sourceControlAi']> {
  const actions = { ...sourceControlAi.actions }
  for (const actionId of AI_TEXT_ACTION_IDS) {
    const recipe = actions[actionId]
    if (!recipe) {
      continue
    }
    // A recipe without its own agent inherits Source Control AI's; null in either picks the default.
    const own = hasActionAgentRecipe(recipe)
    if (isRetiredTextAgent((own ? recipe.agentId : sourceControlAi.agentId) || defaultTuiAgent)) {
      const { agentArgs: _retiredArgs, ...rest } = recipe
      actions[actionId] = own ? { ...rest, agentId: null } : rest
    }
  }
  return {
    ...sourceControlAi,
    agentId: isRetiredTextAgent(sourceControlAi.agentId) ? null : sourceControlAi.agentId,
    ...(sourceControlAi.actions ? { actions } : {})
  }
}

export function pickCommitMessageGenerationSettings(
  settings: CommitMessageGenerationSettings
): CommitMessageGenerationSettings {
  return {
    ...(settings.commitMessageAi !== undefined
      ? {
          commitMessageAi: isRetiredTextAgent(settings.commitMessageAi.agentId)
            ? { ...settings.commitMessageAi, agentId: null }
            : settings.commitMessageAi
        }
      : {}),
    ...(settings.sourceControlAi !== undefined
      ? {
          sourceControlAi: withoutRetiredTextAgents(
            settings.sourceControlAi,
            settings.defaultTuiAgent
          )
        }
      : {}),
    ...(settings.agentCmdOverrides !== undefined
      ? { agentCmdOverrides: settings.agentCmdOverrides }
      : {}),
    // Why: hosts before the contract accepted 'blank' reject it; null picks the same fallback agent.
    ...(settings.defaultTuiAgent !== undefined
      ? {
          defaultTuiAgent:
            settings.defaultTuiAgent === 'blank' || isRetiredTextAgent(settings.defaultTuiAgent)
              ? null
              : settings.defaultTuiAgent
        }
      : {})
  }
}
