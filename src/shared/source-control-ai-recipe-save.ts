import {
  normalizeRepoSourceControlAiOverrides,
  normalizeSourceControlAiSettings
} from './source-control-ai'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  SOURCE_CONTROL_ACTION_IDS,
  SOURCE_CONTROL_TEXT_ACTION_IDS,
  type SourceControlActionId,
  type SourceControlActionRecipe
} from './source-control-ai-actions'
import type {
  CompleteSourceControlActionRecipe,
  RepoSourceControlAiOverrides,
  SourceControlAiOperation,
  SourceControlAiSettings,
  WritableRepoSourceControlAiOverrides
} from './source-control-ai-types'
import type { GlobalSettings, Repo } from './types'

export type SourceControlAiWriteTarget = { type: 'repo'; repoId: string } | { type: 'global' }

export type SourceControlAiRepoUpdate =
  | { sourceControlAi: WritableRepoSourceControlAiOverrides }
  | { sourceControlAi: null }

export type SourceControlActionRecipeSaveResult =
  | { target: { type: 'global' }; sourceControlAi: SourceControlAiSettings }
  | { target: { type: 'repo'; repoId: string }; update: SourceControlAiRepoUpdate }

type SaveSourceControlActionRecipeInput = {
  target: SourceControlAiWriteTarget
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  actionId: SourceControlActionId
  recipe: SourceControlActionRecipe
  customAgentCommand?: string
}

type ReadCompatibleActionRecipe = {
  agentId?: SourceControlActionRecipe['agentId']
  commandInputTemplate?: string | null
  agentArgs?: string | null
}

const TEXT_ACTION_ID_SET = new Set<SourceControlActionId>(SOURCE_CONTROL_TEXT_ACTION_IDS)

function hasEntries(value: Record<string, unknown> | null | undefined): boolean {
  return Object.keys(value ?? {}).length > 0
}

function normalizeStringRecord<T extends string>(
  value: Partial<Record<T, string | null | undefined>> | undefined
): Partial<Record<T, string>> | undefined {
  const normalized: Partial<Record<T, string>> = {}
  for (const [key, item] of Object.entries(value ?? {}) as [T, string | null | undefined][]) {
    if (typeof item === 'string') {
      normalized[key] = item
    }
  }
  return hasEntries(normalized) ? normalized : undefined
}

function normalizeBooleanRecord<T extends string>(
  value: Partial<Record<T, boolean | null | undefined>> | undefined
): Partial<Record<T, boolean>> | undefined {
  const normalized: Partial<Record<T, boolean>> = {}
  for (const [key, item] of Object.entries(value ?? {}) as [T, boolean | null | undefined][]) {
    if (typeof item === 'boolean') {
      normalized[key] = item
    }
  }
  return hasEntries(normalized) ? normalized : undefined
}

function normalizeCompleteRecipe(
  actionId: SourceControlActionId,
  recipe: ReadCompatibleActionRecipe | undefined
): CompleteSourceControlActionRecipe | undefined {
  if (!recipe) {
    return undefined
  }
  const commandInputTemplate =
    typeof recipe.commandInputTemplate === 'string'
      ? recipe.commandInputTemplate
      : DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId]
  const rawAgentArgs = recipe.agentArgs
  const agentArgs = typeof rawAgentArgs === 'string' ? rawAgentArgs.trim() : undefined
  return {
    agentId: recipe.agentId ?? null,
    commandInputTemplate,
    ...(agentArgs !== undefined ? { agentArgs } : {})
  }
}

function normalizeActionOverrides(
  overrides: RepoSourceControlAiOverrides['actionOverrides']
): WritableRepoSourceControlAiOverrides['actionOverrides'] {
  const normalized: WritableRepoSourceControlAiOverrides['actionOverrides'] = {}
  for (const actionId of SOURCE_CONTROL_ACTION_IDS) {
    const recipe = normalizeCompleteRecipe(actionId, overrides?.[actionId])
    if (recipe) {
      normalized[actionId] = recipe
    }
  }
  return hasEntries(normalized) ? normalized : undefined
}

export function normalizeWritableRepoSourceControlAiOverrides(
  value: RepoSourceControlAiOverrides | null | undefined
): WritableRepoSourceControlAiOverrides | undefined {
  const readCompatible = normalizeRepoSourceControlAiOverrides(value)
  if (!readCompatible) {
    return undefined
  }
  const writable: WritableRepoSourceControlAiOverrides = {}
  if (typeof readCompatible.enabled === 'boolean') {
    writable.enabled = readCompatible.enabled
  }
  if (typeof readCompatible.customAgentCommand === 'string') {
    const customAgentCommand = readCompatible.customAgentCommand.trim()
    if (customAgentCommand) {
      writable.customAgentCommand = customAgentCommand
    }
  }
  if (readCompatible.modelOverridesByOperation) {
    writable.modelOverridesByOperation = readCompatible.modelOverridesByOperation
  }
  const instructionsByOperation = normalizeStringRecord(readCompatible.instructionsByOperation)
  if (instructionsByOperation) {
    writable.instructionsByOperation = instructionsByOperation
  }
  const actionOverrides = normalizeActionOverrides(readCompatible.actionOverrides)
  if (actionOverrides) {
    writable.actionOverrides = actionOverrides
  }
  const prCreationDefaults = normalizeBooleanRecord(readCompatible.prCreationDefaults)
  if (prCreationDefaults) {
    writable.prCreationDefaults = prCreationDefaults
  }
  return Object.keys(writable).length > 0 ? writable : undefined
}

export function toSourceControlAiRepoUpdate(
  value: RepoSourceControlAiOverrides | null | undefined
): SourceControlAiRepoUpdate {
  const sourceControlAi = normalizeWritableRepoSourceControlAiOverrides(value)
  return sourceControlAi ? { sourceControlAi } : { sourceControlAi: null }
}

function dropLegacyInstructionForAction(
  value: WritableRepoSourceControlAiOverrides,
  actionId: SourceControlActionId
): WritableRepoSourceControlAiOverrides {
  if (!TEXT_ACTION_ID_SET.has(actionId) || !value.instructionsByOperation) {
    return value
  }
  const instructionsByOperation = { ...value.instructionsByOperation }
  delete instructionsByOperation[actionId as SourceControlAiOperation]
  return {
    ...value,
    instructionsByOperation: hasEntries(instructionsByOperation)
      ? instructionsByOperation
      : undefined
  }
}

function normalizeRecipeForSave(
  actionId: SourceControlActionId,
  recipe: SourceControlActionRecipe
): CompleteSourceControlActionRecipe {
  return (
    normalizeCompleteRecipe(actionId, recipe) ?? {
      agentId: null,
      commandInputTemplate: DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId]
    }
  )
}

export function saveSourceControlActionRecipe(
  input: SaveSourceControlActionRecipeInput
): SourceControlActionRecipeSaveResult {
  const savedRecipe = normalizeRecipeForSave(input.actionId, input.recipe)
  if (input.target.type === 'global') {
    const current = normalizeSourceControlAiSettings(
      input.settings.sourceControlAi,
      input.settings.commitMessageAi
    )
    return {
      target: { type: 'global' },
      sourceControlAi: {
        ...current,
        ...(typeof input.customAgentCommand === 'string'
          ? { customAgentCommand: input.customAgentCommand }
          : {}),
        actions: {
          ...current.actions,
          [input.actionId]: savedRecipe
        }
      }
    }
  }

  const currentRepoAi = normalizeWritableRepoSourceControlAiOverrides(input.repo?.sourceControlAi)
  const next = dropLegacyInstructionForAction(
    {
      ...currentRepoAi,
      ...(typeof input.customAgentCommand === 'string'
        ? { customAgentCommand: input.customAgentCommand }
        : {}),
      actionOverrides: {
        ...currentRepoAi?.actionOverrides,
        [input.actionId]: savedRecipe
      }
    },
    input.actionId
  )
  return {
    target: input.target,
    update: toSourceControlAiRepoUpdate(next)
  }
}
