import type { CommitMessageAiSettings, GlobalSettings, TuiAgent } from '../../../../shared/types'
import {
  getCommitMessageAgentCapability,
  isCustomAgentId,
  type CommitMessageAgentCapability,
  type CommitMessageAgentChoice,
  type CommitMessageModelCapability
} from '../../../../shared/commit-message-agent-spec'
import { getAgentCatalog } from '@/lib/agent-catalog'

export const EMPTY_COMMIT_MESSAGE_AI_SETTINGS: CommitMessageAiSettings = {
  enabled: false,
  agentId: null,
  selectedModelByAgent: {},
  selectedThinkingByModel: {},
  customPrompt: '',
  customAgentCommand: ''
}

export function readCommitMessageAiSettings(settings: GlobalSettings): CommitMessageAiSettings {
  return settings.commitMessageAi ?? EMPTY_COMMIT_MESSAGE_AI_SETTINGS
}

export function commitMessageAgentLabel(
  agentId: TuiAgent,
  capability: CommitMessageAgentCapability
): string {
  return getAgentCatalog().find((a) => a.id === agentId)?.label ?? capability.label
}

export function resolveCommitMessageSelectedModel(
  config: CommitMessageAiSettings,
  capability: CommitMessageAgentCapability
): CommitMessageModelCapability {
  const persisted = config.selectedModelByAgent[capability.id]
  if (persisted) {
    const found = capability.models.find((m) => m.id === persisted)
    if (found) {
      return found
    }
  }
  return capability.models.find((m) => m.id === capability.defaultModelId) ?? capability.models[0]
}

export function resolveCommitMessageSelectedThinking(
  config: CommitMessageAiSettings,
  model: CommitMessageModelCapability
): string | undefined {
  if (!model.thinkingLevels) {
    return undefined
  }
  const persisted = config.selectedThinkingByModel[model.id]
  if (persisted && model.thinkingLevels.some((l) => l.id === persisted)) {
    return persisted
  }
  return model.defaultThinkingLevel
}

export function seedCommitMessageAiEnablePatch(
  config: CommitMessageAiSettings,
  seedAgentId: CommitMessageAgentChoice
): Partial<CommitMessageAiSettings> {
  const seedCapability = isCustomAgentId(seedAgentId)
    ? undefined
    : getCommitMessageAgentCapability(seedAgentId)
  const seedModel = seedCapability
    ? resolveCommitMessageSelectedModel(config, seedCapability)
    : null
  const seedThinking = seedModel
    ? resolveCommitMessageSelectedThinking(config, seedModel)
    : undefined
  const nextSelectedModelByAgent = { ...config.selectedModelByAgent }
  if (seedCapability && !nextSelectedModelByAgent[seedCapability.id]) {
    nextSelectedModelByAgent[seedCapability.id] = seedCapability.defaultModelId
  }
  const nextSelectedThinkingByModel = { ...config.selectedThinkingByModel }
  if (seedModel && seedThinking && !nextSelectedThinkingByModel[seedModel.id]) {
    nextSelectedThinkingByModel[seedModel.id] = seedThinking
  }
  return {
    enabled: true,
    agentId: seedAgentId,
    selectedModelByAgent: nextSelectedModelByAgent,
    selectedThinkingByModel: nextSelectedThinkingByModel
  }
}
