import { isTuiAgent } from './tui-agent-config'
import {
  normalizeActionArgumentDocument,
  reconcileActionArgumentDocument
} from './source-control-action-argument-choices'
import {
  SOURCE_CONTROL_LAUNCH_ACTION_IDS,
  canonicalActionLaunchPreferences,
  type AiActionId,
  type SourceControlActionRecipe
} from './source-control-ai-actions'
import type { RepoSourceControlAiOverrides } from './source-control-ai-types'

type PermissionRecipe = Pick<
  SourceControlActionRecipe,
  'agentId' | 'launchPreferences' | 'argumentChoices'
> & {
  agentArgs?: string | null
}

/** Load keeps stored intent; a deliberate field commit may replace it with an exact typed recipe. */
export function liftActionPermissionArgs<T extends PermissionRecipe>(
  recipe: T,
  edited = false,
  actionId?: AiActionId
): T {
  if (actionId && !SOURCE_CONTROL_LAUNCH_ACTION_IDS.some((id) => id === actionId)) {
    return recipe
  }
  const canonical = canonicalActionLaunchPreferences(recipe.launchPreferences)
  const authored =
    JSON.stringify(canonical) === JSON.stringify(recipe.launchPreferences)
      ? recipe
      : { ...recipe, launchPreferences: canonical }
  if (!isTuiAgent(recipe.agentId) || typeof recipe.agentArgs !== 'string') {
    return authored
  }
  const document = normalizeActionArgumentDocument(
    { ...authored, agentArgs: recipe.agentArgs },
    recipe.argumentChoices,
    recipe.agentId
  )
  const result = reconcileActionArgumentDocument(document, edited ? 'arguments-edit' : 'load')
  return JSON.stringify(result) === JSON.stringify(recipe) ? recipe : { ...recipe, ...result }
}

/** Only the row's own concrete agent proves which CLI grammar its saved text uses. */
export function migrateActionPermissionArgs<
  T extends NonNullable<RepoSourceControlAiOverrides['actionOverrides']>
>(actions: T | undefined): T | undefined {
  if (!actions) {
    return actions
  }
  let next = actions
  for (const id of SOURCE_CONTROL_LAUNCH_ACTION_IDS) {
    const recipe = actions[id]
    if (!recipe) {
      continue
    }
    const lifted = liftActionPermissionArgs(recipe, false, id)
    if (lifted !== recipe) {
      next = { ...next, [id]: lifted }
    }
  }
  return next
}
