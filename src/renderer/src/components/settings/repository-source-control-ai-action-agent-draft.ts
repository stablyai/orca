import { demoteActionArgumentChoices } from '../../../../shared/source-control-action-argument-choices'
import type {
  SourceControlActionRecipe,
  SourceControlActionId,
  SourceControlActionLaunchPreferences
} from '../../../../shared/source-control-ai-actions'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  normalizeRepoAiDraft,
  setActionOverride
} from './repository/source-control/repository-source-control-ai-draft'

type RepoActionRecipe = NonNullable<
  NonNullable<RepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
>

export function withRepoAiActionAgent(
  base: RepoSourceControlAiOverrides,
  _settings: GlobalSettings | null,
  actionId: SourceControlActionId,
  agentId: RepoActionRecipe['agentId'],
  choice?: Pick<SourceControlActionRecipe, 'surface'>
): RepoSourceControlAiOverrides {
  const currentRecipe = base.actionOverrides?.[actionId] ?? {}
  // A model, permission mode and chat-or-CLI pick are one agent's choices; none survives a change.
  const sameAgent = currentRecipe.agentId === agentId
  const { launchPreferences, surface, ...rest } =
    sameAgent || !currentRecipe.argumentChoices
      ? currentRecipe
      : demoteActionArgumentChoices({
          ...currentRecipe,
          agentArgs: currentRecipe.agentArgs ?? undefined
        })
  return normalizeRepoAiDraft(
    setActionOverride(base, actionId, {
      ...rest,
      ...(launchPreferences && sameAgent ? { launchPreferences } : {}),
      ...(choice
        ? choice.surface
          ? { surface: choice.surface }
          : {}
        : surface && sameAgent
          ? { surface }
          : {}),
      agentId
    })
  )
}

export function withRepoAiActionLaunchPreferences(
  base: RepoSourceControlAiOverrides,
  _settings: GlobalSettings | null,
  actionId: SourceControlActionId,
  launchPreferences: SourceControlActionLaunchPreferences | undefined
): RepoSourceControlAiOverrides {
  const { launchPreferences: _previous, ...currentRecipe } = base.actionOverrides?.[actionId] ?? {}
  return normalizeRepoAiDraft(
    setActionOverride(base, actionId, {
      ...currentRecipe,
      ...(launchPreferences ? { launchPreferences } : {})
    })
  )
}
