import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  SOURCE_CONTROL_ACTION_IDS,
  type SourceControlActionLaunchPreferences,
  type SourceControlActionRecipe,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'

export type ActionRecipeDraftValue = {
  commandInputTemplate: string
  agentArgs: string
  launchPreferences?: SourceControlActionLaunchPreferences
}

export type ActionRecipeDraftState = {
  values: Record<SourceControlActionId, ActionRecipeDraftValue>
  baseValues: Record<SourceControlActionId, ActionRecipeDraftValue>
}

function readActionRecipeInputValue(
  config: SourceControlAiSettings,
  actionId: SourceControlActionId
): ActionRecipeDraftValue {
  const recipe = config.actions?.[actionId]
  const value = recipe?.commandInputTemplate
  // Execution trims templates; preserve trailing spaces while the user types the next word.
  return {
    commandInputTemplate:
      typeof value === 'string' ? value : DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId],
    agentArgs: typeof recipe?.agentArgs === 'string' ? recipe.agentArgs : '',
    ...(recipe?.launchPreferences ? { launchPreferences: recipe.launchPreferences } : {})
  }
}

export function readActionRecipeInputValues(
  config: SourceControlAiSettings
): Record<SourceControlActionId, ActionRecipeDraftValue> {
  return Object.fromEntries(
    SOURCE_CONTROL_ACTION_IDS.map((actionId) => [
      actionId,
      readActionRecipeInputValue(config, actionId)
    ])
  ) as Record<SourceControlActionId, ActionRecipeDraftValue>
}

export function serializeActionRecipeInputValues(
  values: Record<SourceControlActionId, ActionRecipeDraftValue>
): string {
  return JSON.stringify(SOURCE_CONTROL_ACTION_IDS.map((actionId) => [actionId, values[actionId]]))
}

/** A successful agent change can retire only the obsolete value it captured. */
export function retireActionLaunchPreferences(
  latest: SourceControlActionLaunchPreferences | undefined,
  captured: SourceControlActionLaunchPreferences | undefined,
  selected: SourceControlActionRecipe['agentId']
): SourceControlActionLaunchPreferences | undefined {
  return captured && latest === captured && captured.agentId !== selected ? undefined : latest
}
