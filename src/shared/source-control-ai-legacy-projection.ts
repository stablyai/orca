import type { CommitMessageAiSettings } from './commit-message-ai-types'
import { readSourceControlActionDefault } from './source-control-ai-actions'
import {
  hasActionAgentRecipe,
  legacyPromptFromCommandTemplate
} from './source-control-ai-command-template'
import { mergeSelectedModelByAgentByHost } from './source-control-ai-model-selection'
import type { SourceControlAiSettings } from './source-control-ai-types'

export function projectSourceControlAiToLegacyCommitMessageAi(
  sourceControlAi: SourceControlAiSettings,
  previousLegacy?: CommitMessageAiSettings | null
): CommitMessageAiSettings {
  const commitMessageChoice = sourceControlAi.modelOverridesByOperation?.commitMessage
  const commitRecipe = readSourceControlActionDefault(sourceControlAi.actions, 'commitMessage')
  return {
    enabled: sourceControlAi.enabled,
    agentId: hasActionAgentRecipe(commitRecipe) ? commitRecipe.agentId : sourceControlAi.agentId,
    selectedModelByAgent: {
      ...sourceControlAi.selectedModelByAgent,
      ...commitMessageChoice?.selectedModelByAgent
    },
    selectedModelByAgentByHost: mergeSelectedModelByAgentByHost(
      sourceControlAi.selectedModelByAgentByHost,
      commitMessageChoice?.selectedModelByAgentByHost
    ),
    discoveredModelsByAgent:
      sourceControlAi.discoveredModelsByAgent === undefined
        ? {}
        : structuredClone(sourceControlAi.discoveredModelsByAgent),
    discoveredModelsByAgentByHost:
      sourceControlAi.discoveredModelsByAgentByHost === undefined
        ? {}
        : structuredClone(sourceControlAi.discoveredModelsByAgentByHost),
    selectedThinkingByModel: {
      ...sourceControlAi.selectedThinkingByModel,
      ...commitMessageChoice?.selectedThinkingByModel
    },
    customPrompt: legacyPromptFromCommandTemplate(
      commitRecipe.commandInputTemplate,
      sourceControlAi.instructionsByOperation.commitMessage ?? previousLegacy?.customPrompt
    ),
    customAgentCommand: sourceControlAi.customAgentCommand
  }
}
