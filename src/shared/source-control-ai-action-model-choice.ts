import { getCommitMessageAgentSpec } from './commit-message-agent-spec'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from './commit-message-host-key'
import { removeSourceControlAiArgumentFlag } from './source-control-ai-argument-flags'
import { normalizeSourceControlAiSettings } from './source-control-ai-settings'
import type {
  SourceControlAiWriteTarget,
  SourceControlActionRecipeSaveResult
} from './source-control-ai-recipe-save'
import { toSourceControlAiRepoUpdate } from './source-control-ai-recipe-save'
import type { GlobalSettings } from './global-settings-types'
import type { Repo } from './repo-types'
import type { AiTextOperation, SourceControlAiModelChoice } from './source-control-ai-types'
import type { TuiAgent } from './tui-agent'
import type { CommandTemplateBackslash } from './commit-message-prompt'

type ActionModelChoiceInput = {
  target: SourceControlAiWriteTarget
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'>
  repo?: Pick<Repo, 'sourceControlAi'> | null
  actionId: AiTextOperation
  agentId: TuiAgent
  change:
    | { field: 'model'; value: string | undefined }
    | { field: 'effort'; modelId: string; value: string | undefined }
  /** Execution hosts this save covers, beyond hosts the saved settings already name. */
  hostKeys?: readonly string[]
  backslash?: CommandTemplateBackslash
}

/** A user pick applies to every host known at save time, including hosts reading the host map. */
function writeChoice(
  choice: SourceControlAiModelChoice | undefined,
  input: ActionModelChoiceInput,
  remoteHostKeys: Iterable<string>,
  pinModel: boolean
): SourceControlAiModelChoice | undefined {
  const next = structuredClone(choice ?? {})
  const { agentId, change } = input
  if (change.field === 'model' || pinModel) {
    const value = change.field === 'model' ? change.value : change.modelId
    next.selectedModelByAgent = { ...next.selectedModelByAgent }
    const byHost = { ...next.selectedModelByAgentByHost }
    next.selectedModelByAgentByHost = byHost
    // The local host reads the host-agnostic value; a local copy would hide the other editor's later picks.
    if (byHost[LOCAL_COMMIT_MESSAGE_HOST_KEY]) {
      const localModels = { ...byHost[LOCAL_COMMIT_MESSAGE_HOST_KEY] }
      delete localModels[agentId]
      byHost[LOCAL_COMMIT_MESSAGE_HOST_KEY] = localModels
    }
    const models = [
      next.selectedModelByAgent,
      ...[...remoteHostKeys].map((hostKey) => {
        const hostModels = { ...byHost[hostKey] }
        byHost[hostKey] = hostModels
        return hostModels
      })
    ]
    for (const modelsByAgent of models) {
      if (value === undefined) {
        delete modelsByAgent[agentId]
      } else {
        modelsByAgent[agentId] = value
      }
    }
  }
  if (change.field === 'effort') {
    next.selectedThinkingByModel = { ...next.selectedThinkingByModel }
    if (change.value === undefined) {
      delete next.selectedThinkingByModel[change.modelId]
    } else {
      next.selectedThinkingByModel[change.modelId] = change.value
    }
  }
  if (next.selectedModelByAgent && !Object.keys(next.selectedModelByAgent).length) {
    delete next.selectedModelByAgent
  }
  for (const [key, models] of Object.entries(next.selectedModelByAgentByHost ?? {})) {
    if (!Object.keys(models ?? {}).length) {
      delete next.selectedModelByAgentByHost?.[key]
    }
  }
  if (!Object.keys(next.selectedModelByAgentByHost ?? {}).length) {
    delete next.selectedModelByAgentByHost
  }
  if (!Object.keys(next.selectedThinkingByModel ?? {}).length) {
    delete next.selectedThinkingByModel
  }
  return Object.keys(next).length ? next : undefined
}

export function saveSourceControlAiActionModelChoice(
  input: ActionModelChoiceInput
): SourceControlActionRecipeSaveResult & { unrecognizedArguments: boolean } {
  const source = normalizeSourceControlAiSettings(
    input.settings.sourceControlAi,
    input.settings.commitMessageAi
  )
  const repo = input.repo?.sourceControlAi
  const scope = input.target.type === 'global' ? source : repo
  const choice =
    input.target.type === 'global'
      ? source.modelOverridesByOperation?.[input.actionId]
      : input.actionId === 'conversationName'
        ? undefined
        : repo?.modelOverridesByOperation?.[input.actionId]
  const remoteHostKeys = new Set([
    ...Object.keys(choice?.selectedModelByAgentByHost ?? {}),
    ...Object.keys(source.selectedModelByAgentByHost ?? {}),
    ...Object.keys(source.discoveredModelsByAgentByHost ?? {}),
    ...Object.keys(input.settings.commitMessageAi?.discoveredModelsByAgentByHost ?? {}),
    ...(input.hostKeys ?? [])
  ])
  remoteHostKeys.delete(LOCAL_COMMIT_MESSAGE_HOST_KEY)
  const recipe =
    input.target.type === 'global'
      ? source.actions?.[input.actionId]
      : input.actionId === 'conversationName'
        ? undefined
        : repo?.actionOverrides?.[input.actionId]
  const spec = getCommitMessageAgentSpec(input.agentId)
  const stripped = spec
    ? removeSourceControlAiArgumentFlag(
        recipe?.agentArgs ?? '',
        spec,
        input.change.field,
        input.backslash
      )
    : { agentArgs: recipe?.agentArgs ?? '', unrecognized: false }
  const pinModel =
    input.change.field === 'effort' &&
    Boolean(spec?.effortFlag.some((flag) => flag.modelVariant)) &&
    stripped.agentArgs !== (recipe?.agentArgs ?? '')
  const nextChoice = writeChoice(choice, input, remoteHostKeys, pinModel)
  const modelOverridesByOperation = { ...scope?.modelOverridesByOperation }
  if (nextChoice) {
    modelOverridesByOperation[input.actionId] = nextChoice
  } else {
    delete modelOverridesByOperation[input.actionId]
  }
  if (input.target.type === 'global') {
    return {
      target: { type: 'global' },
      unrecognizedArguments: stripped.unrecognized,
      sourceControlAi: {
        ...source,
        modelOverridesByOperation,
        actions: {
          ...source.actions,
          [input.actionId]: {
            ...recipe,
            ...(typeof recipe?.agentArgs === 'string' ? { agentArgs: stripped.agentArgs } : {})
          }
        }
      }
    }
  }
  const actionId = input.actionId
  if (actionId === 'conversationName') {
    throw new Error('Chat name model choices are global only')
  }
  return {
    target: input.target,
    unrecognizedArguments: stripped.unrecognized,
    update: toSourceControlAiRepoUpdate({
      ...repo,
      modelOverridesByOperation,
      actionOverrides: {
        ...repo?.actionOverrides,
        [actionId]: {
          ...recipe,
          ...(typeof recipe?.agentArgs === 'string' ? { agentArgs: stripped.agentArgs } : {})
        }
      }
    })
  }
}
