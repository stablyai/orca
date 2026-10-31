import type { CommitMessageAiSettings } from './commit-message-ai-types'
import {
  actionRecipeFromLegacyCommitMessageAi,
  applyLegacyAgentToActionRecipe,
  commandTemplateFromOperationInstruction,
  shouldImportLegacyBranchAgent,
  shouldImportLegacyBranchPrompt
} from './source-control-ai-command-template'
import { projectSourceControlAiToLegacyCommitMessageAi } from './source-control-ai-legacy-projection'
import { normalizeSourceControlAiSettings } from './source-control-ai-settings'
import type { SourceControlAiModelChoice, SourceControlAiSettings } from './source-control-ai-types'
import type { TuiAgent } from './tui-agent'

type LegacyCoreChanges = Record<
  'enabled' | 'agentId' | 'customPrompt' | 'customAgentCommand',
  boolean
>

function copyRecord<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value)
}

function hasEntries(value: Record<string, unknown> | null | undefined): boolean {
  return Object.keys(value ?? {}).length > 0
}

function legacyCoreChanges(
  legacy: CommitMessageAiSettings,
  projected: CommitMessageAiSettings
): LegacyCoreChanges {
  return {
    enabled: legacy.enabled !== projected.enabled,
    agentId: legacy.agentId !== projected.agentId,
    customPrompt: legacy.customPrompt !== projected.customPrompt,
    customAgentCommand: legacy.customAgentCommand !== projected.customAgentCommand
  }
}

function mergeLegacyModelSelectionDelta<T>(
  existing: Record<string, T> | null | undefined,
  legacy: Record<string, T> | null | undefined,
  projected: Record<string, T> | null | undefined
): Record<string, T> | undefined {
  const merged: Record<string, T> = { ...existing }
  let changed = false
  const keys = new Set([...Object.keys(legacy ?? {}), ...Object.keys(projected ?? {})])
  for (const key of keys) {
    const legacyValue = legacy?.[key]
    if (JSON.stringify(projected?.[key]) === JSON.stringify(legacyValue)) {
      continue
    }
    changed = true
    if (Object.hasOwn(legacy ?? {}, key) && legacyValue !== undefined) {
      merged[key] = legacyValue
    } else {
      delete merged[key]
    }
  }
  return changed ? merged : (existing ?? undefined)
}

function mergeLegacyHostModelSelectionDelta(
  existing: Partial<Record<string, Partial<Record<TuiAgent, string>>>> | null | undefined,
  legacy: Partial<Record<string, Partial<Record<TuiAgent, string>>>> | null | undefined,
  projected: Partial<Record<string, Partial<Record<TuiAgent, string>>>> | null | undefined
): Partial<Record<string, Partial<Record<TuiAgent, string>>>> | undefined {
  const merged = copyRecord(existing) ?? {}
  let changed = false
  const hostKeys = new Set([...Object.keys(legacy ?? {}), ...Object.keys(projected ?? {})])
  for (const hostKey of hostKeys) {
    const nextHostModels = mergeLegacyModelSelectionDelta(
      merged[hostKey],
      legacy?.[hostKey],
      projected?.[hostKey]
    )
    if (nextHostModels !== merged[hostKey]) {
      changed = true
    }
    if (nextHostModels && Object.keys(nextHostModels).length > 0) {
      merged[hostKey] = nextHostModels
    } else {
      delete merged[hostKey]
    }
  }
  return changed ? merged : (existing ?? undefined)
}

export function mergeLegacyCommitMessageAiIntoSourceControlAi(
  sourceControlAi: SourceControlAiSettings | null | undefined,
  legacy: CommitMessageAiSettings | null | undefined,
  options: { pullRequestInstructionsFromLegacy?: boolean } = {}
): SourceControlAiSettings {
  const base = normalizeSourceControlAiSettings(sourceControlAi, legacy)
  if (!legacy) {
    return base
  }
  if (!sourceControlAi) {
    return normalizeSourceControlAiSettings(
      {
        ...base,
        enabled: legacy.enabled,
        agentId: legacy.agentId,
        selectedModelByAgent: { ...legacy.selectedModelByAgent },
        selectedModelByAgentByHost: copyRecord(legacy.selectedModelByAgentByHost) ?? {},
        discoveredModelsByAgent: copyRecord(legacy.discoveredModelsByAgent) ?? {},
        discoveredModelsByAgentByHost: copyRecord(legacy.discoveredModelsByAgentByHost) ?? {},
        selectedThinkingByModel: { ...legacy.selectedThinkingByModel },
        customAgentCommand: legacy.customAgentCommand,
        instructionsByOperation: {
          ...base.instructionsByOperation,
          commitMessage: legacy.customPrompt ?? '',
          branchName: legacy.customPrompt ?? '',
          ...(options.pullRequestInstructionsFromLegacy
            ? { pullRequest: legacy.customPrompt ?? '' }
            : {})
        }
      },
      legacy
    )
  }

  const existingChoice = base.modelOverridesByOperation?.commitMessage
  const projected = projectSourceControlAiToLegacyCommitMessageAi(base)
  const selectedModelByAgent = mergeLegacyModelSelectionDelta(
    existingChoice?.selectedModelByAgent,
    legacy.selectedModelByAgent,
    projected.selectedModelByAgent
  )
  const selectedModelByAgentByHost = mergeLegacyHostModelSelectionDelta(
    existingChoice?.selectedModelByAgentByHost,
    legacy.selectedModelByAgentByHost,
    projected.selectedModelByAgentByHost
  )
  const selectedThinkingByModel = mergeLegacyModelSelectionDelta(
    existingChoice?.selectedThinkingByModel,
    legacy.selectedThinkingByModel,
    projected.selectedThinkingByModel
  )
  const shouldMergeModels =
    selectedModelByAgent !== existingChoice?.selectedModelByAgent ||
    selectedModelByAgentByHost !== existingChoice?.selectedModelByAgentByHost ||
    selectedThinkingByModel !== existingChoice?.selectedThinkingByModel
  const modelOverridesByOperation = { ...base.modelOverridesByOperation }
  if (shouldMergeModels) {
    const nextChoice: SourceControlAiModelChoice = {}
    if (hasEntries(selectedModelByAgent)) {
      nextChoice.selectedModelByAgent = selectedModelByAgent
    }
    if (hasEntries(selectedModelByAgentByHost)) {
      nextChoice.selectedModelByAgentByHost = selectedModelByAgentByHost
    }
    if (hasEntries(selectedThinkingByModel)) {
      nextChoice.selectedThinkingByModel = selectedThinkingByModel
    }
    if (Object.keys(nextChoice).length > 0) {
      modelOverridesByOperation.commitMessage = nextChoice
    } else {
      delete modelOverridesByOperation.commitMessage
    }
  }

  const legacyActionRecipe = actionRecipeFromLegacyCommitMessageAi(legacy)
  const changes = legacyCoreChanges(legacy, projected)
  const shouldMergeCore = Object.values(changes).some(Boolean)
  const shouldMergeBranchPrompt =
    changes.customPrompt && shouldImportLegacyBranchPrompt(base, projected)
  const shouldMergeBranchAgent = changes.agentId && shouldImportLegacyBranchAgent(base, projected)
  return normalizeSourceControlAiSettings(
    {
      ...base,
      discoveredModelsByAgent: copyRecord(legacy.discoveredModelsByAgent) ?? {},
      discoveredModelsByAgentByHost: copyRecord(legacy.discoveredModelsByAgentByHost) ?? {},
      ...(shouldMergeCore
        ? {
            ...(changes.enabled ? { enabled: legacy.enabled } : {}),
            ...(changes.agentId ? { agentId: legacy.agentId } : {}),
            ...(changes.customAgentCommand
              ? { customAgentCommand: legacy.customAgentCommand }
              : {}),
            instructionsByOperation: {
              ...base.instructionsByOperation,
              ...(changes.customPrompt ? { commitMessage: legacy.customPrompt ?? '' } : {}),
              ...(shouldMergeBranchPrompt ? { branchName: legacy.customPrompt ?? '' } : {}),
              ...(changes.customPrompt && options.pullRequestInstructionsFromLegacy
                ? { pullRequest: legacy.customPrompt ?? '' }
                : {})
            },
            actions: {
              ...base.actions,
              commitMessage: {
                ...(changes.agentId
                  ? applyLegacyAgentToActionRecipe(base.actions?.commitMessage, legacy.agentId)
                  : base.actions?.commitMessage),
                ...(changes.customPrompt
                  ? { commandInputTemplate: legacyActionRecipe.commandInputTemplate }
                  : {})
              },
              branchName: {
                ...(shouldMergeBranchAgent
                  ? applyLegacyAgentToActionRecipe(base.actions?.branchName, legacy.agentId)
                  : base.actions?.branchName),
                ...(shouldMergeBranchPrompt
                  ? {
                      commandInputTemplate: commandTemplateFromOperationInstruction(
                        'branchName',
                        legacy.customPrompt
                      )
                    }
                  : {})
              }
            }
          }
        : {}),
      modelOverridesByOperation
    },
    shouldMergeCore ? legacy : undefined
  )
}
