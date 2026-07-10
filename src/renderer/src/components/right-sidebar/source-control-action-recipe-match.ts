import { isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import {
  normalizeRepoSourceControlAiOverrides,
  normalizeSourceControlAiSettings,
  resolveSourceControlActionRecipe
} from '../../../../shared/source-control-ai'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  type SourceControlActionId,
  type SourceControlActionRecipe
} from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import type { GlobalSettings, Repo } from '../../../../shared/types'

type NormalizedSourceControlActionRecipe = {
  agentId: SourceControlActionRecipe['agentId'] | null
  commandInputTemplate: string
  agentArgs: string
}

type PersistedSourceControlActionRecipe = {
  agentId?: SourceControlActionRecipe['agentId']
  commandInputTemplate?: string | null
  agentArgs?: string | null
}

function normalizeSourceControlActionRecipeForComparison(
  actionId: SourceControlActionId,
  recipe: PersistedSourceControlActionRecipe | null | undefined
): NormalizedSourceControlActionRecipe {
  return {
    agentId: recipe?.agentId ?? null,
    commandInputTemplate:
      typeof recipe?.commandInputTemplate === 'string'
        ? recipe.commandInputTemplate.trim()
        : DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId],
    agentArgs: typeof recipe?.agentArgs === 'string' ? recipe.agentArgs.trim() : ''
  }
}

function sourceControlActionRecipesMatch(
  left: NormalizedSourceControlActionRecipe,
  right: NormalizedSourceControlActionRecipe
): boolean {
  return (
    left.agentId === right.agentId &&
    left.commandInputTemplate === right.commandInputTemplate &&
    left.agentArgs === right.agentArgs
  )
}

function readSavedSourceControlActionRecipeAtTarget(input: {
  actionId: SourceControlActionId
  target: SourceControlAiWriteTarget
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null | undefined
  repo?: Pick<Repo, 'sourceControlAi'> | null
}): PersistedSourceControlActionRecipe | null {
  if (input.target.type === 'repo') {
    const repoRecipe = normalizeRepoSourceControlAiOverrides(input.repo?.sourceControlAi)
      ?.actionOverrides?.[input.actionId]
    if (!repoRecipe) {
      return null
    }
    return resolveSourceControlActionRecipe({
      actionId: input.actionId,
      settings: input.settings,
      repo: input.repo
    })
  }
  const source = normalizeSourceControlAiSettings(
    input.settings?.sourceControlAi,
    input.settings?.commitMessageAi
  )
  return source.actions?.[input.actionId] ?? null
}

function readSavedCustomAgentCommandAtTarget(input: {
  target: SourceControlAiWriteTarget
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null | undefined
  repo?: Pick<Repo, 'sourceControlAi'> | null
}): string {
  if (input.target.type === 'repo') {
    return (
      normalizeRepoSourceControlAiOverrides(
        input.repo?.sourceControlAi
      )?.customAgentCommand?.trim() ?? ''
    )
  }
  return normalizeSourceControlAiSettings(
    input.settings?.sourceControlAi,
    input.settings?.commitMessageAi
  ).customAgentCommand.trim()
}

export function sourceControlActionRecipeMatchesTarget(input: {
  actionId: SourceControlActionId
  target: SourceControlAiWriteTarget
  recipe: SourceControlActionRecipe
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null | undefined
  repo?: Pick<Repo, 'sourceControlAi'> | null
  customAgentCommand?: string
}): boolean {
  const savedRecipe = readSavedSourceControlActionRecipeAtTarget(input)
  if (!savedRecipe) {
    return false
  }
  const current = normalizeSourceControlActionRecipeForComparison(input.actionId, input.recipe)
  const saved = normalizeSourceControlActionRecipeForComparison(input.actionId, savedRecipe)
  if (!sourceControlActionRecipesMatch(current, saved)) {
    return false
  }
  if (!isCustomAgentId(current.agentId)) {
    return true
  }
  return (input.customAgentCommand ?? '').trim() === readSavedCustomAgentCommandAtTarget(input)
}
