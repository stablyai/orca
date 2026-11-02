import { sourceControlActionRecipeEntry } from '../../../../shared/source-control-action-selection'
import { isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import { trimActionArgumentDocument } from '../../../../shared/source-control-action-argument-choices'
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
import {
  saveSourceControlActionRecipe,
  type SourceControlAiWriteTarget
} from '../../../../shared/source-control-ai-recipe-save'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'

type NormalizedSourceControlActionRecipe = {
  agentId: SourceControlActionRecipe['agentId'] | null
  commandInputTemplate: string
  agentArgs: string | undefined
  launchPreferences: string
  argumentChoices: string
  surface: string
}

type PersistedSourceControlActionRecipe = {
  agentId?: SourceControlActionRecipe['agentId']
  commandInputTemplate?: string | null
  agentArgs?: string | null
  argumentChoices?: SourceControlActionRecipe['argumentChoices']
  launchPreferences?: SourceControlActionRecipe['launchPreferences']
  surface?: SourceControlActionRecipe['surface']
  resolvedChoiceSources?: SourceControlActionRecipe['resolvedChoiceSources']
}

function normalizeSourceControlActionRecipeForComparison(
  actionId: SourceControlActionId,
  recipe: PersistedSourceControlActionRecipe | null | undefined
): NormalizedSourceControlActionRecipe {
  const document = trimActionArgumentDocument({
    agentArgs: typeof recipe?.agentArgs === 'string' ? recipe.agentArgs : undefined,
    argumentChoices: recipe?.argumentChoices
  })
  const { model: selection, permission } = sourceControlActionRecipeEntry({
    ...recipe,
    agentArgs: document.agentArgs,
    argumentChoices: document.argumentChoices,
    commandInputTemplate: recipe?.commandInputTemplate ?? undefined
  }).resolvedChoiceSources
  return {
    agentId: recipe?.agentId ?? null,
    commandInputTemplate:
      typeof recipe?.commandInputTemplate === 'string'
        ? recipe.commandInputTemplate.trim()
        : DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId],
    agentArgs: document.agentArgs,
    argumentChoices: JSON.stringify(document.argumentChoices ?? null),
    launchPreferences:
      permission || selection
        ? JSON.stringify([
            permission?.agentId ?? null,
            selection?.base ?? null,
            selection?.model ? [selection.model.agentId, selection.model.value] : null,
            Object.entries(selection?.options ?? {})
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, entry.agentId, entry.value]),
            permission?.permissionMode ?? null
          ])
        : '',
    surface: recipe?.surface ?? ''
  }
}

function sourceControlActionRecipesMatch(
  left: NormalizedSourceControlActionRecipe,
  right: NormalizedSourceControlActionRecipe
): boolean {
  return (
    left.agentId === right.agentId &&
    left.commandInputTemplate === right.commandInputTemplate &&
    left.agentArgs === right.agentArgs &&
    left.launchPreferences === right.launchPreferences &&
    left.argumentChoices === right.argumentChoices &&
    left.surface === right.surface
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
    return repoRecipe
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
  const saved = normalizeSourceControlActionRecipeForComparison(
    input.actionId,
    input.target.type === 'repo' ? resolveSourceControlActionRecipe(input) : savedRecipe
  )
  if (!sourceControlActionRecipesMatch(current, saved)) {
    return false
  }
  if (!isCustomAgentId(current.agentId)) {
    return true
  }
  return (input.customAgentCommand ?? '').trim() === readSavedCustomAgentCommandAtTarget(input)
}

export function sourceControlActionRecipeSaveMatchesTarget(
  input: Parameters<typeof sourceControlActionRecipeMatchesTarget>[0]
): boolean {
  const stored = readSavedSourceControlActionRecipeAtTarget(input)
  if (!stored || !input.settings) {
    return false
  }
  const saved = saveSourceControlActionRecipe({ ...input, settings: input.settings })
  const planned =
    'sourceControlAi' in saved
      ? saved.sourceControlAi.actions?.[input.actionId]
      : saved.update.sourceControlAi?.actionOverrides?.[input.actionId]
  // A complete save owns these fields; inherited equal values do not establish that ownership.
  return Boolean(
    planned &&
    stored.agentId === planned.agentId &&
    stored.commandInputTemplate === planned.commandInputTemplate &&
    stored.agentArgs === planned.agentArgs &&
    sourceControlActionRecipesMatch(
      normalizeSourceControlActionRecipeForComparison(input.actionId, stored),
      normalizeSourceControlActionRecipeForComparison(input.actionId, planned)
    ) &&
    (!isCustomAgentId(planned.agentId) ||
      (input.customAgentCommand ?? '').trim() === readSavedCustomAgentCommandAtTarget(input))
  )
}
