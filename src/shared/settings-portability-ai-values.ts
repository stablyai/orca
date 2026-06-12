import type { SourceControlAiSettings } from './source-control-ai-types'
import type { CommitMessageAiModelCapability, CommitMessageAiSettings } from './types'
import { getDefaultSettings } from './constants'
import { isTuiAgent } from './tui-agent-config'
import {
  SOURCE_CONTROL_TEXT_ACTION_IDS,
  normalizeSourceControlAiActionDefaults,
  type SourceControlTextActionId
} from './source-control-ai-actions'

const DEFAULT_SETTINGS_FOR_IMPORT_VALIDATION = getDefaultSettings('')

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSafeRecordKey(key: string): boolean {
  return key !== '' && key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) {
    return {}
  }
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (isSafeRecordKey(key) && typeof item === 'string') {
      result[key] = item
    }
  }
  return result
}

function sanitizeAgentStringRecord(value: unknown): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {}
  for (const [key, item] of Object.entries(sanitizeStringRecord(value))) {
    if (isTuiAgent(key)) {
      result[key] = item
    }
  }
  return result
}

function sanitizeHostAgentStringRecord(
  value: unknown
): Record<string, Partial<Record<string, string>>> {
  if (!isPlainObject(value)) {
    return {}
  }
  const result: Record<string, Partial<Record<string, string>>> = {}
  for (const [hostKey, hostModels] of Object.entries(value)) {
    if (!isSafeRecordKey(hostKey)) {
      continue
    }
    const sanitized = sanitizeAgentStringRecord(hostModels)
    if (Object.keys(sanitized).length > 0) {
      result[hostKey] = sanitized
    }
  }
  return result
}

function sanitizeModelCapability(value: unknown): CommitMessageAiModelCapability | null {
  if (!isPlainObject(value) || typeof value.id !== 'string' || typeof value.label !== 'string') {
    return null
  }
  const thinkingLevels = Array.isArray(value.thinkingLevels)
    ? value.thinkingLevels
        .map((level) =>
          isPlainObject(level) && typeof level.id === 'string' && typeof level.label === 'string'
            ? { id: level.id, label: level.label }
            : null
        )
        .filter((level): level is { id: string; label: string } => level !== null)
    : undefined
  return {
    id: value.id,
    label: value.label,
    ...(thinkingLevels && thinkingLevels.length > 0 ? { thinkingLevels } : {}),
    ...(typeof value.defaultThinkingLevel === 'string'
      ? { defaultThinkingLevel: value.defaultThinkingLevel }
      : {})
  }
}

function sanitizeAgentModelCapabilities(
  value: unknown
): Partial<Record<string, CommitMessageAiModelCapability[]>> {
  if (!isPlainObject(value)) {
    return {}
  }
  const result: Partial<Record<string, CommitMessageAiModelCapability[]>> = {}
  for (const [agent, models] of Object.entries(value)) {
    if (!isTuiAgent(agent) || !Array.isArray(models)) {
      continue
    }
    result[agent] = models
      .map(sanitizeModelCapability)
      .filter((model): model is CommitMessageAiModelCapability => model !== null)
  }
  return result
}

function sanitizeHostAgentModelCapabilities(
  value: unknown
): Record<string, Partial<Record<string, CommitMessageAiModelCapability[]>>> {
  if (!isPlainObject(value)) {
    return {}
  }
  const result: Record<string, Partial<Record<string, CommitMessageAiModelCapability[]>>> = {}
  for (const [hostKey, hostModels] of Object.entries(value)) {
    if (!isSafeRecordKey(hostKey)) {
      continue
    }
    const sanitized = sanitizeAgentModelCapabilities(hostModels)
    if (Object.keys(sanitized).length > 0) {
      result[hostKey] = sanitized
    }
  }
  return result
}

export function sanitizeCommitMessageAi(value: CommitMessageAiSettings): CommitMessageAiSettings {
  const defaults = DEFAULT_SETTINGS_FOR_IMPORT_VALIDATION.commitMessageAi!
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : defaults.enabled,
    agentId:
      value.agentId === null || value.agentId === 'custom' || isTuiAgent(value.agentId)
        ? value.agentId
        : defaults.agentId,
    selectedModelByAgent: sanitizeAgentStringRecord(value.selectedModelByAgent),
    selectedModelByAgentByHost: sanitizeHostAgentStringRecord(value.selectedModelByAgentByHost),
    discoveredModelsByAgent: sanitizeAgentModelCapabilities(value.discoveredModelsByAgent),
    discoveredModelsByAgentByHost: sanitizeHostAgentModelCapabilities(
      value.discoveredModelsByAgentByHost
    ),
    selectedThinkingByModel: sanitizeStringRecord(value.selectedThinkingByModel),
    customPrompt:
      typeof value.customPrompt === 'string' ? value.customPrompt : defaults.customPrompt,
    customAgentCommand:
      typeof value.customAgentCommand === 'string'
        ? value.customAgentCommand
        : defaults.customAgentCommand
  }
}

function sanitizeSourceControlModelChoice(value: unknown): {
  selectedModelByAgent?: Partial<Record<string, string>>
  selectedModelByAgentByHost?: Record<string, Partial<Record<string, string>>>
  selectedThinkingByModel?: Record<string, string>
} | null {
  if (!isPlainObject(value)) {
    return null
  }
  const selectedModelByAgent = sanitizeAgentStringRecord(value.selectedModelByAgent)
  const selectedModelByAgentByHost = sanitizeHostAgentStringRecord(value.selectedModelByAgentByHost)
  const selectedThinkingByModel = sanitizeStringRecord(value.selectedThinkingByModel)
  const result = {
    ...(Object.keys(selectedModelByAgent).length > 0 ? { selectedModelByAgent } : {}),
    ...(Object.keys(selectedModelByAgentByHost).length > 0 ? { selectedModelByAgentByHost } : {}),
    ...(Object.keys(selectedThinkingByModel).length > 0 ? { selectedThinkingByModel } : {})
  }
  return Object.keys(result).length > 0 ? result : null
}

function sanitizeSourceControlModelOverrides(
  value: unknown
): Partial<
  Record<
    SourceControlTextActionId,
    NonNullable<ReturnType<typeof sanitizeSourceControlModelChoice>>
  >
> {
  if (!isPlainObject(value)) {
    return {}
  }
  const result: Partial<
    Record<
      SourceControlTextActionId,
      NonNullable<ReturnType<typeof sanitizeSourceControlModelChoice>>
    >
  > = {}
  for (const operation of SOURCE_CONTROL_TEXT_ACTION_IDS) {
    const sanitized = sanitizeSourceControlModelChoice(value[operation])
    if (sanitized) {
      result[operation] = sanitized
    }
  }
  return result
}

export function sanitizeSourceControlAi(value: SourceControlAiSettings): SourceControlAiSettings {
  const defaults = DEFAULT_SETTINGS_FOR_IMPORT_VALIDATION.sourceControlAi!
  const instructionsByOperation: SourceControlAiSettings['instructionsByOperation'] = {}
  if (isPlainObject(value.instructionsByOperation)) {
    for (const operation of SOURCE_CONTROL_TEXT_ACTION_IDS) {
      const instruction = value.instructionsByOperation[operation]
      if (typeof instruction === 'string') {
        instructionsByOperation[operation] = instruction
      }
    }
  }
  const modelOverridesByOperation = sanitizeSourceControlModelOverrides(
    value.modelOverridesByOperation
  )
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : defaults.enabled,
    actions: normalizeSourceControlAiActionDefaults(value.actions) ?? {},
    agentId:
      value.agentId === null || value.agentId === 'custom' || isTuiAgent(value.agentId)
        ? value.agentId
        : defaults.agentId,
    selectedModelByAgent: sanitizeAgentStringRecord(value.selectedModelByAgent),
    selectedModelByAgentByHost: sanitizeHostAgentStringRecord(value.selectedModelByAgentByHost),
    discoveredModelsByAgent: sanitizeAgentModelCapabilities(value.discoveredModelsByAgent),
    discoveredModelsByAgentByHost: sanitizeHostAgentModelCapabilities(
      value.discoveredModelsByAgentByHost
    ),
    selectedThinkingByModel: sanitizeStringRecord(value.selectedThinkingByModel),
    customAgentCommand:
      typeof value.customAgentCommand === 'string'
        ? value.customAgentCommand
        : defaults.customAgentCommand,
    instructionsByOperation,
    ...(Object.keys(modelOverridesByOperation).length > 0 ? { modelOverridesByOperation } : {}),
    prCreationDefaults: {
      draft:
        typeof value.prCreationDefaults?.draft === 'boolean'
          ? value.prCreationDefaults.draft
          : defaults.prCreationDefaults?.draft,
      useTemplate:
        typeof value.prCreationDefaults?.useTemplate === 'boolean'
          ? value.prCreationDefaults.useTemplate
          : defaults.prCreationDefaults?.useTemplate,
      generateDetailsOnOpen:
        typeof value.prCreationDefaults?.generateDetailsOnOpen === 'boolean'
          ? value.prCreationDefaults.generateDetailsOnOpen
          : defaults.prCreationDefaults?.generateDetailsOnOpen,
      openAfterCreate:
        typeof value.prCreationDefaults?.openAfterCreate === 'boolean'
          ? value.prCreationDefaults.openAfterCreate
          : defaults.prCreationDefaults?.openAfterCreate
    },
    launchActionDefaults: normalizeSourceControlAiActionDefaults(value.launchActionDefaults) ?? {}
  }
}
