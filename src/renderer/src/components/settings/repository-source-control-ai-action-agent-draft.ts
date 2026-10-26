import type {
  SourceControlActionId,
  SourceControlActionLaunchPreferences
} from '../../../../shared/source-control-ai-actions'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  normalizeRepoAiDraft,
  readCompleteRecipeForDraft,
  setActionOverride
} from './repository-source-control-ai-draft'

type RepoActionRecipe = NonNullable<
  NonNullable<RepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
>

export function withRepoAiActionAgent(
  base: RepoSourceControlAiOverrides,
  settings: GlobalSettings | null,
  actionId: SourceControlActionId,
  agentId: RepoActionRecipe['agentId']
): RepoSourceControlAiOverrides {
  const currentRecipe = readCompleteRecipeForDraft(base, settings, actionId)
  // A model and permission mode are one agent's choices; neither survives a change of agent.
  const { launchPreferences, ...rest } = currentRecipe
  return normalizeRepoAiDraft(
    setActionOverride(base, actionId, {
      ...rest,
      ...(launchPreferences && currentRecipe.agentId === agentId ? { launchPreferences } : {}),
      agentId
    })
  )
}

export function withRepoAiActionLaunchPreferences(
  base: RepoSourceControlAiOverrides,
  settings: GlobalSettings | null,
  actionId: SourceControlActionId,
  launchPreferences: SourceControlActionLaunchPreferences | undefined
): RepoSourceControlAiOverrides {
  const { launchPreferences: _previous, ...currentRecipe } = readCompleteRecipeForDraft(
    base,
    settings,
    actionId
  )
  return normalizeRepoAiDraft(
    setActionOverride(base, actionId, {
      ...currentRecipe,
      ...(launchPreferences ? { launchPreferences } : {})
    })
  )
}
