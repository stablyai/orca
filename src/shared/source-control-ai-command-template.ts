import { CUSTOM_AGENT_ID, isCustomAgentId, type CustomAgentId } from './commit-message-agent-spec'
import type { CommitMessageAiSettings } from './commit-message-ai-types'
import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  readSourceControlActionDefault,
  type SourceControlActionRecipe
} from './source-control-ai-actions'
import type { SourceControlAiOperation, SourceControlAiSettings } from './source-control-ai-types'
import type { TuiAgent } from './tui-agent'

export function commandTemplateFromInstruction(instruction: string | null | undefined): string {
  const trimmed = instruction?.trim()
  return trimmed ? ['{basePrompt}', '', trimmed].join('\n') : '{basePrompt}'
}

export function commandTemplateFromOperationInstruction(
  operation: SourceControlAiOperation,
  instruction: string | null | undefined
): string {
  const trimmed = instruction?.trim()
  if (!trimmed) {
    return '{basePrompt}'
  }
  return operation === 'branchName'
    ? [trimmed, '', '{basePrompt}'].join('\n')
    : commandTemplateFromInstruction(trimmed)
}

export function isLegacyBranchInstructionTemplate(
  operation: SourceControlAiOperation,
  instruction: string | null | undefined,
  template: string | null | undefined
): boolean {
  return (
    operation === 'branchName' &&
    Boolean(instruction?.trim()) &&
    template === commandTemplateFromInstruction(instruction)
  )
}

export function actionRecipeFromLegacyCommitMessageAi(legacy: CommitMessageAiSettings): {
  agentId?: TuiAgent | CustomAgentId | null
  commandInputTemplate: string
} {
  return {
    ...(legacy.agentId === null
      ? { agentId: null }
      : isCustomAgentId(legacy.agentId)
        ? { agentId: CUSTOM_AGENT_ID }
        : legacy.agentId
          ? { agentId: legacy.agentId }
          : {}),
    commandInputTemplate: commandTemplateFromInstruction(legacy.customPrompt)
  }
}

export function legacyPromptFromCommandTemplate(
  template: string | undefined,
  fallback: string | undefined
): string {
  const trimmed = template?.trim()
  if (!trimmed || trimmed === '{basePrompt}') {
    return fallback ?? ''
  }
  return trimmed.startsWith('{basePrompt}') ? trimmed.slice('{basePrompt}'.length).trim() : trimmed
}

export function hasActionAgentRecipe(recipe: {
  agentId?: TuiAgent | CustomAgentId | null
}): recipe is { agentId: TuiAgent | CustomAgentId | null } {
  return Object.hasOwn(recipe, 'agentId')
}

export function applyLegacyAgentToActionRecipe(
  recipe: SourceControlActionRecipe | undefined,
  agentId: CommitMessageAiSettings['agentId']
): SourceControlActionRecipe {
  const next = { ...recipe }
  if (agentId === null) {
    next.agentId = null
  } else if (isCustomAgentId(agentId)) {
    next.agentId = CUSTOM_AGENT_ID
  } else if (agentId) {
    next.agentId = agentId
  } else {
    delete next.agentId
  }
  return next
}

export function shouldImportLegacyBranchPrompt(
  base: SourceControlAiSettings,
  projectedLegacy: CommitMessageAiSettings
): boolean {
  const branchRecipe = readSourceControlActionDefault(base.actions, 'branchName')
  const projectedTemplate = commandTemplateFromOperationInstruction(
    'branchName',
    projectedLegacy.customPrompt
  )
  return (
    branchRecipe.commandInputTemplate === undefined ||
    branchRecipe.commandInputTemplate ===
      DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES.branchName ||
    branchRecipe.commandInputTemplate === projectedTemplate
  )
}

export function shouldImportLegacyBranchAgent(
  base: SourceControlAiSettings,
  projectedLegacy: CommitMessageAiSettings
): boolean {
  const branchRecipe = readSourceControlActionDefault(base.actions, 'branchName')
  return !hasActionAgentRecipe(branchRecipe) || branchRecipe.agentId === projectedLegacy.agentId
}
