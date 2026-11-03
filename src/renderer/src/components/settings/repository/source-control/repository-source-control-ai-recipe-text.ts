import type {
  RepoSourceControlAiOverrides,
  SourceControlAiModelChoice
} from '../../../../../../shared/source-control-ai-types'
import type { SourceControlActionId } from '../../../../../../shared/source-control-ai-actions'
import type { SourceControlAiModelEdits } from '../../../../../../shared/source-control-ai-action-model-edits'
type RepoActionRecipe = NonNullable<
  NonNullable<RepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
>

/** The action's text as stored: an unset or cleared value stays so until the user types; inputs
 *  show it as empty. */
export type ActionRecipeTextDraft = Pick<
  RepoActionRecipe,
  'commandInputTemplate' | 'agentArgs' | 'launchPreferences' | 'argumentChoices'
> & { modelChoice?: SourceControlAiModelChoice; modelEdits?: SourceControlAiModelEdits }

// An own undefined is a deliberate clear; an absent preference leaves inheritance untouched.
export function sameDraftLaunchPreferences(
  a: ActionRecipeTextDraft,
  b: ActionRecipeTextDraft
): boolean {
  return (
    Object.hasOwn(a, 'launchPreferences') === Object.hasOwn(b, 'launchPreferences') &&
    JSON.stringify(a.launchPreferences) === JSON.stringify(b.launchPreferences)
  )
}

export function sameActionRecipeText(a: ActionRecipeTextDraft, b: ActionRecipeTextDraft): boolean {
  return (
    JSON.stringify(a.modelEdits) === JSON.stringify(b.modelEdits) &&
    a.commandInputTemplate === b.commandInputTemplate &&
    a.agentArgs === b.agentArgs &&
    JSON.stringify(a.argumentChoices) === JSON.stringify(b.argumentChoices) &&
    sameDraftLaunchPreferences(a, b)
  )
}

export function readActionRecipeTextDraft(
  value: RepoSourceControlAiOverrides,
  actionId: SourceControlActionId
): ActionRecipeTextDraft {
  const recipe = value.actionOverrides?.[actionId]
  const choices: Partial<Record<string, SourceControlAiModelChoice>> =
    value.modelOverridesByOperation ?? {}
  return {
    modelChoice: choices[actionId],
    commandInputTemplate: recipe?.commandInputTemplate,
    agentArgs: recipe?.agentArgs,
    argumentChoices: recipe?.argumentChoices,
    ...(recipe?.launchPreferences ? { launchPreferences: recipe.launchPreferences } : {})
  }
}
