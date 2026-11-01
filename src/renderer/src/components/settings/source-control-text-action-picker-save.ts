import {
  agentPickerEffectiveChoices,
  type AgentPickerEntry,
  type AgentPickerDraft
} from '../../../../shared/agent-launch-picker'
import { saveSourceControlAiActionModelChoice } from '../../../../shared/source-control-ai-action-model-choice'
import type {
  AiTextOperation,
  SourceControlAiSettings,
  SourceControlAiModelChoice,
  RepoSourceControlAiOverrides
} from '../../../../shared/source-control-ai-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'

export function saveSourceControlTextPickerDraft({
  source,
  repoAi,
  repoId,
  choice,
  agentArgs,
  operation,
  settings,
  agent,
  entry,
  draft
}: {
  source: SourceControlAiSettings
  repoAi?: RepoSourceControlAiOverrides
  repoId?: string
  choice?: SourceControlAiModelChoice
  agentArgs: string
  operation: AiTextOperation
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null
  agent: AgentPickerEntry['agent']
  entry: AgentPickerEntry
  draft: AgentPickerDraft
}) {
  const scope = repoId ? 'repo' : 'global'
  let currentSource: SourceControlAiSettings = {
    ...source,
    modelOverridesByOperation: {
      ...source.modelOverridesByOperation,
      ...(scope === 'global' ? { [operation]: choice } : {})
    },
    actions: {
      ...source.actions,
      ...(scope === 'global' ? { [operation]: { ...source.actions?.[operation], agentArgs } } : {})
    }
  }
  let currentRepo: Pick<Repo, 'sourceControlAi'> | null =
    operation !== 'conversationName' && repoId
      ? {
          sourceControlAi: {
            ...repoAi,
            modelOverridesByOperation: {
              ...repoAi?.modelOverridesByOperation,
              [operation]: choice
            },
            actionOverrides: {
              ...repoAi?.actionOverrides,
              [operation]: { ...repoAi?.actionOverrides?.[operation], agentArgs }
            }
          }
        }
      : null
  let nextArgs = agentArgs
  let nextChoice = choice
  const effective = agentPickerEffectiveChoices(entry, draft)
  for (const field of draft.textChanges ?? []) {
    const saved = saveSourceControlAiActionModelChoice({
      target: repoId ? { type: 'repo', repoId: repoId } : { type: 'global' },
      settings: { ...settings, sourceControlAi: currentSource },
      repo: currentRepo,
      actionId: operation,
      agentId: agent,
      change:
        field === 'model'
          ? { field, value: draft.choices.model }
          : {
              field,
              modelId: effective.model ?? '',
              value: draft.choices.options?.effort
            }
    })
    if ('sourceControlAi' in saved) {
      currentSource = saved.sourceControlAi
      nextChoice = currentSource.modelOverridesByOperation?.[operation]
      nextArgs = currentSource.actions?.[operation]?.agentArgs ?? nextArgs
    } else if (operation !== 'conversationName') {
      currentRepo = { sourceControlAi: saved.update.sourceControlAi }
      nextChoice = currentRepo.sourceControlAi?.modelOverridesByOperation?.[operation]
      nextArgs = currentRepo.sourceControlAi?.actionOverrides?.[operation]?.agentArgs ?? nextArgs
    }
  }
  return { choice: nextChoice, agentArgs: nextArgs }
}
