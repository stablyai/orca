import type { NewTabAgentMenuModel } from '../tab-bar/new-tab-agent-menu-model'
import { sourceControlModelLabel, sourceControlThinkingLabel } from './source-control-model-label'
import type { CommitMessageAiSettings } from '../../../../shared/commit-message-ai-types'
import type { CommitMessageAgentCapability } from '../../../../shared/commit-message-agent-spec'
import {
  agentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import {
  commitMessageAgentLabel,
  resolveCommitMessageSelectedModel,
  resolveCommitMessageSelectedThinking
} from './ai-commit-pr-settings-helpers'

export function aiCommitPrPickerEntry(
  capability: CommitMessageAgentCapability,
  config: CommitMessageAiSettings
): AgentPickerEntry {
  const model = resolveCommitMessageSelectedModel(config, capability)
  const effort = resolveCommitMessageSelectedThinking(config, model)
  return {
    agent: capability.id,
    label: commitMessageAgentLabel(capability.id, capability),
    rows: [{ agent: capability.id, kind: 'cli' }],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    terminal: { model: model.id, ...(effort ? { options: { effort } } : {}) },
    structured: {},
    arguments: '',
    textGeneration: {
      modelInArguments: false,
      effortInArguments: false,
      modelArgumentsUnrecognized: false,
      effortArgumentsUnrecognized: false,
      effortInModel: false,
      effortByModel: Object.fromEntries(
        capability.models.map((model) => [
          model.id,
          resolveCommitMessageSelectedThinking(config, model)
        ])
      )
    },
    catalog: {
      origin: 'probe',
      fetchedAt: 0,
      models: capability.models.map((model) => ({
        id: model.id,
        label: sourceControlModelLabel(model),
        isDefault: model.id === capability.defaultModelId,
        efforts:
          model.thinkingLevels?.map((level) => ({
            value: level.id,
            label: sourceControlThinkingLabel(level)
          })) ?? [],
        defaultEffort: model.defaultThinkingLevel
      }))
    }
  }
}

export function aiCommitPrPickerDraft(entry: AgentPickerEntry) {
  return { ...agentPickerDraft(entry), choices: entry.terminal }
}

export function commitMessagePickerModel(entries: AgentPickerEntry[]): NewTabAgentMenuModel {
  const detectedIds = entries.map((entry) => entry.agent)
  return {
    state: 'settled',
    rows: entries.flatMap((entry) => entry.rows),
    detection: {
      detectedIds,
      isLoading: false,
      detectionFailed: false,
      isRefreshing: false,
      needsServerUpdate: false,
      refresh: async () => detectedIds
    }
  }
}
