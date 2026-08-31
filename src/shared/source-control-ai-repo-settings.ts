import type { TuiAgent } from './tui-agent'
import {
  SOURCE_CONTROL_ACTION_IDS,
  SOURCE_CONTROL_TEXT_ACTION_IDS,
  normalizeSourceControlActionRecipe,
  type SourceControlActionId
} from './source-control-ai-actions'
import {
  commandTemplateFromOperationInstruction,
  isLegacyBranchInstructionTemplate
} from './source-control-ai-command-template'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiModelChoice
} from './source-control-ai-types'

type RepoActionOverride = NonNullable<
  NonNullable<RepoSourceControlAiOverrides['actionOverrides']>[SourceControlActionId]
>

const PR_CREATION_DEFAULT_KEYS = [
  'draft',
  'useTemplate',
  'generateDetailsOnOpen',
  'openAfterCreate'
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeRecordKey(key: string): boolean {
  return key !== '' && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const normalized: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (isSafeRecordKey(key) && typeof item === 'string') {
      normalized[key] = item
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeAgentModelRecord(value: unknown): Partial<Record<TuiAgent, string>> | undefined {
  return normalizeStringRecord(value) as Partial<Record<TuiAgent, string>> | undefined
}

function normalizeHostAgentModelRecord(
  value: unknown
): Partial<Record<string, Partial<Record<TuiAgent, string>>>> | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const normalized: Partial<Record<string, Partial<Record<TuiAgent, string>>>> = {}
  for (const [hostKey, hostModels] of Object.entries(value)) {
    if (!isSafeRecordKey(hostKey)) {
      continue
    }
    const models = normalizeAgentModelRecord(hostModels)
    if (models) {
      normalized[hostKey] = models
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeModelChoice(value: unknown): SourceControlAiModelChoice | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const choice: SourceControlAiModelChoice = {}
  const selectedModelByAgent = normalizeAgentModelRecord(value.selectedModelByAgent)
  const selectedModelByAgentByHost = normalizeHostAgentModelRecord(value.selectedModelByAgentByHost)
  const selectedThinkingByModel = normalizeStringRecord(value.selectedThinkingByModel)
  if (selectedModelByAgent) {
    choice.selectedModelByAgent = selectedModelByAgent
  }
  if (selectedModelByAgentByHost) {
    choice.selectedModelByAgentByHost = selectedModelByAgentByHost
  }
  if (selectedThinkingByModel) {
    choice.selectedThinkingByModel = selectedThinkingByModel
  }
  return Object.keys(choice).length > 0 ? choice : undefined
}

function normalizeKnownRecord<K extends string, T>(
  value: unknown,
  keys: readonly K[],
  normalizeValue: (value: unknown) => T | undefined
): Partial<Record<K, T>> | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const normalized: Partial<Record<K, T>> = {}
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      continue
    }
    const item = normalizeValue(value[key])
    if (item !== undefined) {
      normalized[key] = item
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizePrCreationDefaults(
  value: unknown
): RepoSourceControlAiOverrides['prCreationDefaults'] {
  if (!isRecord(value)) {
    return undefined
  }
  const normalized: NonNullable<RepoSourceControlAiOverrides['prCreationDefaults']> = {}
  for (const key of PR_CREATION_DEFAULT_KEYS) {
    if (typeof value[key] === 'boolean' || value[key] === null) {
      normalized[key] = value[key]
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function normalizeRepoSourceControlAiOverrides(
  value: unknown
): RepoSourceControlAiOverrides | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const normalized: RepoSourceControlAiOverrides = {}
  if (typeof value.enabled === 'boolean') {
    normalized.enabled = value.enabled
  }
  if (typeof value.customAgentCommand === 'string' && value.customAgentCommand.trim()) {
    normalized.customAgentCommand = value.customAgentCommand.trim()
  }
  const modelOverridesByOperation = normalizeKnownRecord(
    value.modelOverridesByOperation,
    SOURCE_CONTROL_TEXT_ACTION_IDS,
    normalizeModelChoice
  )
  if (modelOverridesByOperation) {
    normalized.modelOverridesByOperation = modelOverridesByOperation
  }
  const instructionsByOperation = normalizeKnownRecord(
    value.instructionsByOperation,
    SOURCE_CONTROL_TEXT_ACTION_IDS,
    (item): string | null | undefined =>
      typeof item === 'string' || item === null ? item : undefined
  )
  if (instructionsByOperation) {
    normalized.instructionsByOperation = instructionsByOperation
  }
  const actionOverrides = normalizeKnownRecord<SourceControlActionId, RepoActionOverride>(
    value.actionOverrides,
    SOURCE_CONTROL_ACTION_IDS,
    (item) => {
      if (!isRecord(item)) {
        return undefined
      }
      const recipe: RepoActionOverride = { ...normalizeSourceControlActionRecipe(item) }
      if (item.commandInputTemplate === null) {
        recipe.commandInputTemplate = null
      }
      if (item.agentArgs === null) {
        recipe.agentArgs = null
      }
      return Object.keys(recipe).length > 0 ? recipe : undefined
    }
  )
  const migratedActionOverrides = { ...actionOverrides }
  for (const operation of SOURCE_CONTROL_TEXT_ACTION_IDS) {
    const instruction = instructionsByOperation?.[operation]
    const existingTemplate = migratedActionOverrides[operation]?.commandInputTemplate
    if (
      typeof instruction === 'string' &&
      (existingTemplate === undefined ||
        isLegacyBranchInstructionTemplate(operation, instruction, existingTemplate))
    ) {
      migratedActionOverrides[operation] = {
        ...migratedActionOverrides[operation],
        commandInputTemplate: commandTemplateFromOperationInstruction(operation, instruction)
      }
    }
  }
  if (Object.keys(migratedActionOverrides).length > 0) {
    normalized.actionOverrides = migratedActionOverrides
  }
  const prCreationDefaults = normalizePrCreationDefaults(value.prCreationDefaults)
  if (prCreationDefaults) {
    normalized.prCreationDefaults = prCreationDefaults
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}
