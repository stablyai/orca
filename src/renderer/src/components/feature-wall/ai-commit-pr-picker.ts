import type { NewTabAgentMenuModel } from '../tab-bar/new-tab-agent-menu-model'
import { sourceControlModelLabel, sourceControlThinkingLabel } from './source-control-model-label'
import type { CommitMessageAiSettings } from '../../../../shared/source-control/ai/generation/commit-message-ai-types'
import type { CommitMessageAgentCapability } from '../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import {
  agentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import {
  commitMessageAgentLabel,
  resolveCommitMessageSelectedModel,
  resolveCommitMessageSelectedThinking
} from './ai-commit-pr-settings-helpers'
import type { Translate } from '../../i18n/use-translate'
import type { TextGenerationAgentId } from '../../../../shared/on-device-text-generation'

/** The picker keys entries by opaque agent id; on-device is a labelled entry with no CLI launch path. */
export function pickerAgent(
  id: TextGenerationAgentId | null | undefined
): AgentPickerEntry['agent'] | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the picker treats the id as an opaque key and only renders the matching entry.
  return id as AgentPickerEntry['agent'] | null
}

export function sourceControlAgentPickerEntry(
  capability: CommitMessageAgentCapability
): AgentPickerEntry {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: picker entries are keyed by opaque agent id; on-device never reaches a CLI launch path.
  const agent = capability.id as AgentPickerEntry['agent']
  return {
    agent,
    label: commitMessageAgentLabel(capability.id, capability),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same opaque picker key; the row only carries the id and its static CLI shape.
    rows: [{ agent: capability.id as AgentPickerEntry['agent'], kind: 'cli' }],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    catalog: { origin: 'unknown' },
    arguments: ''
  }
}

export function aiCommitPrPickerEntry(
  capability: CommitMessageAgentCapability,
  config: CommitMessageAiSettings,
  t?: Translate
): AgentPickerEntry {
  const model = resolveCommitMessageSelectedModel(config, capability)
  const effort = resolveCommitMessageSelectedThinking(config, model)
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: picker rows are keyed by opaque agent id; on-device never reaches a CLI launch path.
    agent: capability.id as AgentPickerEntry['agent'],
    label: commitMessageAgentLabel(capability.id, capability),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same opaque picker key; the row only carries the id and its static CLI shape.
    rows: [{ agent: capability.id as AgentPickerEntry['agent'], kind: 'cli' }],
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
        label: sourceControlModelLabel(model, t),
        isDefault: model.id === capability.defaultModelId,
        efforts:
          model.thinkingLevels?.map((level) => ({
            value: level.id,
            label: sourceControlThinkingLabel(level, t)
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
