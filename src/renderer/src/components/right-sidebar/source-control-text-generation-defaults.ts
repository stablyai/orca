import {
  normalizeRepoSourceControlAiOverrides,
  type ResolvedSourceControlAiGenerationParams
} from '../../../../shared/source-control-ai'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  type SourceControlActionRecipe,
  type SourceControlTextActionId
} from '../../../../shared/source-control-ai-actions'
import type { GlobalSettings, Repo } from '../../../../shared/types'

type TextGenerationRecipeConfiguration = {
  agentId?: SourceControlActionRecipe['agentId']
  commandInputTemplate?: string | null
  agentArgs?: string | null
}

function textGenerationRecipeIsConfigured(
  actionId: SourceControlTextActionId,
  recipe: TextGenerationRecipeConfiguration | null | undefined
): boolean {
  if (Object.prototype.hasOwnProperty.call(recipe ?? {}, 'agentId')) {
    return true
  }
  if (
    typeof recipe?.commandInputTemplate === 'string' &&
    recipe.commandInputTemplate.trim() !== DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId]
  ) {
    return true
  }
  return typeof recipe?.agentArgs === 'string' && recipe.agentArgs.trim().length > 0
}

export function generationParamsToActionRecipe(
  params: ResolvedSourceControlAiGenerationParams
): SourceControlActionRecipe {
  return {
    agentId: params.agentId,
    commandInputTemplate: params.commandInputTemplate ?? '{basePrompt}',
    ...(params.agentArgs !== undefined ? { agentArgs: params.agentArgs } : {})
  }
}

export function hasConfiguredSourceControlTextGenerationDefaults(input: {
  actionId: SourceControlTextActionId
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null | undefined
  repo?: Pick<Repo, 'sourceControlAi'> | null
}): boolean {
  const repoRecipe = normalizeRepoSourceControlAiOverrides(input.repo?.sourceControlAi)
    ?.actionOverrides?.[input.actionId]
  if (textGenerationRecipeIsConfigured(input.actionId, repoRecipe)) {
    return true
  }
  if (
    textGenerationRecipeIsConfigured(
      input.actionId,
      input.settings?.sourceControlAi?.actions?.[input.actionId]
    )
  ) {
    return true
  }
  return (
    input.settings?.sourceControlAi?.agentId != null ||
    (input.actionId === 'commitMessage' && input.settings?.commitMessageAi?.agentId != null)
  )
}

export function hasConfiguredCommitMessageGenerationDefaults(input: {
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null | undefined
  repo?: Pick<Repo, 'sourceControlAi'> | null
}): boolean {
  return hasConfiguredSourceControlTextGenerationDefaults({
    ...input,
    actionId: 'commitMessage'
  })
}
