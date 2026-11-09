import { demoteActionArgumentChoices } from '../../../../../../shared/source-control/ai/recipes/source-control-action-argument-document'
import { resolveSourceControlActionRecipe } from '../../../../../../shared/source-control/ai/source-control-ai-operation-policy'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  type SourceControlActionRecipe,
  type SourceControlActionId
} from '../../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import type { RepoSourceControlAiOverrides } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'

export type RepoActionRecipe = NonNullable<
  NonNullable<RepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
>

function completeRepoActionRecipe(
  recipe: SourceControlActionRecipe,
  actionId: SourceControlActionId
): NonNullable<
  NonNullable<RepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
> {
  if (recipe.argumentChoices && recipe.argumentChoices.syntaxAgent !== recipe.agentId) {
    recipe = demoteActionArgumentChoices(recipe)
  }
  const commandInputTemplate =
    typeof recipe.commandInputTemplate === 'string'
      ? recipe.commandInputTemplate
      : DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId]
  return {
    agentId: recipe.agentId ?? null,
    commandInputTemplate,
    ...(typeof recipe.agentArgs === 'string' ? { agentArgs: recipe.agentArgs } : {}),
    ...(recipe.argumentChoices ? { argumentChoices: recipe.argumentChoices } : {}),
    ...(recipe.launchPreferences ? { launchPreferences: recipe.launchPreferences } : {}),
    ...(recipe.surface ? { surface: recipe.surface } : {})
  }
}

/** The action an edit starts from: the complete recipe it resolves to, owned or partial, keeping a
 *  saved explicit args clear and never the agent only detected to run a default selection. */
export function readCompleteRecipeForDraft(
  current: RepoSourceControlAiOverrides,
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi' | 'defaultTuiAgent'> | null,
  actionId: SourceControlActionId
): RepoActionRecipe {
  const recipe = resolveSourceControlActionRecipe({
    settings,
    repo: { sourceControlAi: current },
    actionId
  })
  const cleared = current.actionOverrides?.[actionId]?.agentArgs === null
  return { ...completeRepoActionRecipe(recipe, actionId), ...(cleared ? { agentArgs: null } : {}) }
}
