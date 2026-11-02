import {
  agentPickerEffectiveChoices,
  type AgentPickerEntry,
  type AgentPickerDraft
} from '../../../../shared/agent-launch-picker'
import { saveSourceControlAiActionModelChoice } from '../../../../shared/source-control-ai-action-model-choice'
import {
  addSourceControlAiModelEdit,
  type SourceControlAiModelEdit,
  type SourceControlAiModelEdits
} from '../../../../shared/source-control-ai-action-model-edits'
import { textActionArgumentsOwnEffort } from '../../../../shared/source-control-text-action-picker'
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
  draft,
  edits,
  hostKeys
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
  /** The card's earlier unsaved menu edits; Save replays all of them against current settings. */
  edits?: SourceControlAiModelEdits
  /** Hosts the preview covers; Save covers the hosts registered when it writes. */
  hostKeys: readonly string[]
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
  let nextEdits = edits
  for (const field of draft.textChanges ?? []) {
    // The menu shows this Effort as set by Arguments, so an older draft's effort edit is not applied.
    if (field === 'effort' && textActionArgumentsOwnEffort(entry, draft)) {
      continue
    }
    const change: SourceControlAiModelEdit =
      field === 'model'
        ? { field, value: draft.choices.model }
        : { field, modelId: effective.model ?? '', value: draft.choices.options?.effort }
    nextEdits = addSourceControlAiModelEdit(nextEdits, agent, change)
    const saved = saveSourceControlAiActionModelChoice({
      target: repoId ? { type: 'repo', repoId: repoId } : { type: 'global' },
      settings: { ...settings, sourceControlAi: currentSource },
      repo: currentRepo,
      actionId: operation,
      agentId: agent,
      hostKeys,
      change
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
  return { choice: nextChoice, agentArgs: nextArgs, edits: nextEdits }
}
