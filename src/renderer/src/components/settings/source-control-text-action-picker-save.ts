import {
  agentPickerEffectiveChoices,
  type AgentPickerEntry,
  type AgentPickerDraft
} from '../../../../shared/agent-launch-picker'
import { saveSourceControlAiActionModelChoice } from '../../../../shared/source-control-ai-action-model-choice'
import {
  removeSourceControlAiArgumentFlag,
  rewriteSourceControlAiArgumentFlagValue
} from '../../../../shared/source-control-ai-argument-flags'
import {
  getCommitMessageAgentSpec,
  type CommitMessageAgentSpec
} from '../../../../shared/commit-message-agent-spec'
import type {
  AiTextOperation,
  SourceControlAiSettings,
  SourceControlAiModelChoice,
  RepoSourceControlAiOverrides
} from '../../../../shared/source-control-ai-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'

/** The model a shared `model#variant` operand in Arguments runs, and whether the menu lists it. */
function argumentsVariantModel(
  agent: AgentPickerEntry['agent'],
  agentArgs: string,
  entry: AgentPickerEntry
): { spec: CommitMessageAgentSpec; model: string; listed: boolean } | undefined {
  const spec = getCommitMessageAgentSpec(agent)
  if (!spec?.effortFlag.some((flag) => flag.modelVariant)) {
    return undefined
  }
  const operand = removeSourceControlAiArgumentFlag(agentArgs, spec, 'effort').value
  if (!operand) {
    return undefined
  }
  const variant = operand.lastIndexOf('#')
  const model = variant !== -1 ? operand.slice(0, variant) : operand
  const listed =
    entry.catalog.origin !== 'unknown' &&
    entry.catalog.models.some((candidate) => candidate.id === model)
  return { spec, model, listed }
}

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
  /** Hosts the card's commands run on, so their host-specific picks are replaced too. */
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
  for (const field of draft.textChanges ?? []) {
    // An effort-only edit keeps the model the Arguments ran; an unlisted one stays in Arguments.
    const variant =
      field === 'effort' && !draft.textChanges?.includes('model')
        ? argumentsVariantModel(agent, nextArgs, entry)
        : undefined
    if (variant && !variant.listed) {
      const effort = draft.choices.options?.effort
      nextArgs = rewriteSourceControlAiArgumentFlagValue(nextArgs, variant.spec, 'effort', () =>
        effort ? `${variant.model}#${effort}` : variant.model
      )
      continue
    }
    const saved = saveSourceControlAiActionModelChoice({
      target: repoId ? { type: 'repo', repoId: repoId } : { type: 'global' },
      settings: { ...settings, sourceControlAi: currentSource },
      repo: currentRepo,
      actionId: operation,
      agentId: agent,
      hostKeys,
      change:
        field === 'model'
          ? { field, value: draft.choices.model }
          : {
              field,
              modelId: variant?.model ?? effective.model ?? '',
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
